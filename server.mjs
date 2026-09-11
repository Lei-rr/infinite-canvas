import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

// 容器内固定常量
const PORT = 8000;
const BACKUP_DIR = "/app/data/images";

// 环境变量配置 (直接在 docker-compose.yml 的 environment 中配置)
const UPSTREAM_URL = (process.env.UPSTREAM_URL || "http://localhost:3000").replace(/\/+$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || "";
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 5);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 2000);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);
const STAGGER_INTERVAL_MS = Number(process.env.STAGGER_INTERVAL_MS || 1200);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 120000);
const IMAGE_DOWNLOAD_TIMEOUT_MS = Number(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS || 120000);

// 确保图片本地持久化目录就绪
try {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
} catch (e) {
  console.warn("Failed to create backup dir:", e.message);
}

// 内存映射：图片文件名 -> 上游原始绝对下载地址
const imageUpstreamMap = new Map();

// 带错峰平滑调度的并发队列 (避免瞬时多并发撞毁同一个上游 Token)
class ConcurrencyQueue {
  constructor(max = 3, minIntervalMs = 1200) {
    this.max = max;
    this.active = 0;
    this.waiting = [];
    this.minIntervalMs = minIntervalMs;
    this.lastDispatchedAt = 0;
  }

  async acquire() {
    return new Promise((resolve) => {
      const execute = async () => {
        this.active++;
        const now = Date.now();
        const elapsed = now - this.lastDispatchedAt;
        if (elapsed < this.minIntervalMs) {
          await new Promise((r) => setTimeout(r, this.minIntervalMs - elapsed));
        }
        this.lastDispatchedAt = Date.now();
        resolve(() => this.release());
      };

      if (this.active < this.max) {
        execute();
      } else {
        this.waiting.push(execute);
      }
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    if (this.waiting.length > 0 && this.active < this.max) {
      const next = this.waiting.shift();
      if (next) next();
    }
  }
}

const queue = new ConcurrencyQueue(MAX_CONCURRENT, STAGGER_INTERVAL_MS);

// 声明支持的模型列表供前端读取
const SUPPORTED_MODELS = [
  { id: "gemini-3.1-flash-image", object: "model" },
  { id: "gemini-3.1-flash-image-2K", object: "model" },
  { id: "gemini-3.1-flash-image-4K", object: "model" },
  { id: "gemini-3.8-flash", object: "model" },
];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

// 画幅比例注入 (--ar 1:1, 16:9, etc.)
function injectAspectRatio(prompt, size) {
  if (!size || typeof size !== "string") return prompt;
  if (/--ar\s+\d+:\d+/i.test(prompt)) return prompt;
  const parts = size.split("x");
  if (parts.length !== 2) return prompt;
  const width = parseInt(parts[0], 10);
  const height = parseInt(parts[1], 10);
  if (!width || !height) return prompt;

  let ratioStr = "";
  const ratio = width / height;
  if (Math.abs(ratio - 16 / 9) < 0.05) ratioStr = "16:9";
  else if (Math.abs(ratio - 9 / 16) < 0.05) ratioStr = "9:16";
  else if (Math.abs(ratio - 4 / 3) < 0.05) ratioStr = "4:3";
  else if (Math.abs(ratio - 3 / 4) < 0.05) ratioStr = "3:4";
  else if (Math.abs(ratio - 1) < 0.05) ratioStr = "1:1";
  else if (Math.abs(ratio - 21 / 9) < 0.05) ratioStr = "21:9";

  return ratioStr ? `${prompt.trim()} --ar ${ratioStr}` : prompt;
}

// 从上游返回内容中提取图片 URL (支持 Markdown 语法与裸链接)
function extractImageUrl(content) {
  if (!content || typeof content !== "string") return null;
  const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
  if (mdMatch) return mdMatch[1];
  const urlMatch = content.match(/(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s"'<>]*)?)/i);
  if (urlMatch) return urlMatch[1];
  const rawUrl = content.trim().match(/^https?:\/\/[^\s]+$/);
  if (rawUrl) return rawUrl[0];
  return null;
}

// 带指数退避与随机抖动的重试控制函数
async function withRetry(fn, taskName = "生图操作", maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      console.warn(`[重试] ${taskName} 第 ${attempt}/${maxRetries} 次失败: ${err.message}`);
      if (attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 600) + 200;
        const delay = RETRY_DELAY_MS * attempt + jitter;
        console.log(`[重试] 等待 ${delay}ms 后进行重试...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// 将上游原始图片链接重写为本地持久化直链
function rewriteImageUrl(originalUrl) {
  if (!originalUrl) return "";
  try {
    const filename = path.basename(new URL(originalUrl).pathname);
    imageUpstreamMap.set(filename, originalUrl);
    backupImage(filename, originalUrl);
    return `/images/${filename}`;
  } catch {
    return originalUrl;
  }
}

// 异步下载图片落盘存储
async function backupImage(filename, originalUrl) {
  const dest = path.join(BACKUP_DIR, filename);
  try {
    await fs.access(dest);
    return;
  } catch {}

  try {
    const res = await fetch(originalUrl, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) return;
    const arrayBuffer = await res.arrayBuffer();
    await fs.writeFile(dest, Buffer.from(arrayBuffer));
    console.log(`[持久化] 图片已成功保存至本地: ${dest}`);
  } catch (err) {
    console.warn(`[持久化] 异步下载备份图片失败 (${originalUrl}):`, err.message);
  }
}

// 本地图片流式直出服务
async function serveImage(req, res, filename) {
  const safeFilename = path.basename(filename);
  const localPath = path.join(BACKUP_DIR, safeFilename);

  // 1. 本地缓存命中，直接以高性能只读流返回
  try {
    const stat = await fs.stat(localPath);
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "image/jpeg",
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=604800, immutable",
    });
    if (req.method === "HEAD") return res.end();
    return fsSync.createReadStream(localPath).pipe(res);
  } catch {}

  // 2. 本地未命中，向上游实时拉取并写盘
  const upstreamUrl = imageUpstreamMap.get(safeFilename) || (UPSTREAM_URL ? `${UPSTREAM_URL}/images/${safeFilename}` : "");
  if (!upstreamUrl) {
    return sendJson(res, 404, { error: "Image not found" });
  }

  try {
    const upRes = await fetch(upstreamUrl, { signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS) });
    if (!upRes.ok) {
      return sendJson(res, upRes.status, { error: "Image not found on upstream" });
    }

    const arrayBuffer = await upRes.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    fs.writeFile(localPath, buf).catch(() => {});

    const contentType = upRes.headers.get("content-type") || "image/jpeg";
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=604800, immutable",
    });
    if (req.method === "HEAD") return res.end();
    return res.end(buf);
  } catch (err) {
    console.error(`[ImageService] 拉取上游图片失败 ${upstreamUrl}:`, err.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: "Failed to fetch image from upstream" });
    }
  }
}

// 核心文生图处理函数
async function handleGenerate(req, res) {
  let bodyText = "";
  for await (const chunk of req) {
    bodyText += chunk;
  }
  let body = {};
  try {
    body = JSON.parse(bodyText);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const model = body.model || "gemini-3.1-flash-image";
  const rawPrompt = body.prompt || "";
  const prompt = injectAspectRatio(rawPrompt, body.size);
  const count = Math.max(1, Math.min(10, Number(body.n) || 1));

  console.log(`[BFF] 文生图请求: model=${model}, count=${count}, prompt="${prompt.slice(0, 45)}..."`);

  try {
    const fetchSingle = async (index) => {
      const release = await queue.acquire();
      try {
        return await withRetry(async () => {
          const upRes = await fetch(`${UPSTREAM_URL}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${UPSTREAM_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content: "You are an AI image generation engine. You must directly generate and output an image matching the prompt. Do not reply with conversational text, advice, or suggestions.",
                },
                { role: "user", content: prompt },
              ],
              stream: false,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

          if (!upRes.ok) {
            const errorText = await upRes.text();
            throw new Error(`上游 HTTP ${upRes.status}: ${errorText.slice(0, 150)}`);
          }

          const data = await upRes.json();
          const choice = data?.choices?.[0];
          const content = choice?.message?.content || "";
          const imgUrl = extractImageUrl(content);
          if (!imgUrl) {
            const finishReason = choice?.finish_reason || "unknown";
            const refusal = choice?.message?.refusal || "";
            const reasoning = choice?.message?.reasoning_content || "";
            console.warn(`[BFF] 生图未返回有效地址: finish_reason=${finishReason}, refusal=${refusal || "none"}, reasoningLength=${reasoning.length}, rawContent="${content.slice(0, 120)}"`);
            throw new Error(`上游未返回有效图片地址 (finish_reason: ${finishReason})`);
          }

          return rewriteImageUrl(imgUrl);
        }, `生图任务 #${index + 1}`);
      } finally {
        release();
      }
    };

    const urls = await Promise.all(Array.from({ length: count }, (_, i) => fetchSingle(i)));

    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: urls.map((url) => ({ url })),
    });
  } catch (err) {
    console.error("[BFF] 生图最终失败:", err.message);
    return sendJson(res, 500, { error: { message: err.message || "生图失败" } });
  }
}

// 核心图生图/多模态图片编辑处理函数
async function handleEdits(req, res) {
  try {
    const webReq = new Request("http://localhost" + req.url, {
      method: req.method,
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: "half",
    });

    const formData = await webReq.formData();
    const model = (formData.get("model") || "gemini-3.1-flash-image").toString();
    const rawPrompt = (formData.get("prompt") || "").toString();
    const size = (formData.get("size") || "").toString();
    const prompt = injectAspectRatio(rawPrompt, size);
    const count = Math.max(1, Math.min(10, Number(formData.get("n")) || 1));

    const imageParts = [];
    for (const [key, value] of formData.entries()) {
      if ((key === "image" || key === "image[]") && typeof value === "object" && typeof value.arrayBuffer === "function") {
        const buf = Buffer.from(await value.arrayBuffer());
        const mime = value.type || "image/png";
        const b64 = `data:${mime};base64,${buf.toString("base64")}`;
        imageParts.push({ type: "image_url", image_url: { url: b64 } });
      }
    }

    const messagesContent = [
      { type: "text", text: prompt },
      ...imageParts,
    ];

    console.log(`[BFF] 图生图/编辑请求: model=${model}, refImages=${imageParts.length}, prompt="${prompt.slice(0, 45)}..."`);

    const fetchSingle = async (index) => {
      const release = await queue.acquire();
      try {
        return await withRetry(async () => {
          const upRes = await fetch(`${UPSTREAM_URL}/v1/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${UPSTREAM_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model,
              messages: [
                {
                  role: "system",
                  content: "You are an AI image editing and generation engine. You must directly output the modified or generated image. Do not reply with conversational text, advice, or suggestions.",
                },
                { role: "user", content: messagesContent },
              ],
              stream: false,
            }),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });

          if (!upRes.ok) {
            const errorText = await upRes.text();
            throw new Error(`上游 HTTP ${upRes.status}: ${errorText.slice(0, 150)}`);
          }

          const data = await upRes.json();
          const choice = data?.choices?.[0];
          const content = choice?.message?.content || "";
          const imgUrl = extractImageUrl(content);
          if (!imgUrl) {
            const finishReason = choice?.finish_reason || "unknown";
            const refusal = choice?.message?.refusal || "";
            const reasoning = choice?.message?.reasoning_content || "";
            console.warn(`[BFF] 图生图未返回有效地址: finish_reason=${finishReason}, refusal=${refusal || "none"}, reasoningLength=${reasoning.length}, rawContent="${content.slice(0, 120)}"`);
            throw new Error(`上游未返回有效图片地址 (finish_reason: ${finishReason})`);
          }

          return rewriteImageUrl(imgUrl);
        }, `图生图任务 #${index + 1}`);
      } finally {
        release();
      }
    };

    const urls = await Promise.all(Array.from({ length: count }, (_, i) => fetchSingle(i)));

    return sendJson(res, 200, {
      created: Math.floor(Date.now() / 1000),
      data: urls.map((url) => ({ url })),
    });
  } catch (err) {
    console.error("[BFF] 图生图最终失败:", err.message);
    return sendJson(res, 500, { error: { message: err.message || "图生图失败" } });
  }
}

// 适配前端画布调用的 /v1/responses 协议 (包含 OpenAI Chat Stream 转换为 Responses Stream)
async function handleResponses(req, res) {
  let bodyText = "";
  for await (const chunk of req) {
    bodyText += chunk;
  }
  let body = {};
  try {
    body = JSON.parse(bodyText);
  } catch {}

  const model = body.model || "gemini-3.8-flash";
  let messages = [];
  if (Array.isArray(body.input)) {
    messages = body.input.map((item) => {
      let content = "";
      if (typeof item.content === "string") {
        content = item.content;
      } else if (Array.isArray(item.content)) {
        content = item.content.map((c) => c.text || "").join("");
      }
      return { role: item.role || "user", content };
    });
  } else {
    messages = [{ role: "user", content: String(body.input || "") }];
  }

  const isStream = Boolean(body.stream);
  try {
    const upRes = await fetch(`${UPSTREAM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${UPSTREAM_KEY}`,
        "Content-Type": "application/json",
        ...(isStream ? { Accept: "text/event-stream" } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        stream: isStream,
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!upRes.ok) {
      const errText = await upRes.text();
      return sendJson(res, upRes.status, { error: { message: errText } });
    }

    // 非流式响应适配
    if (!isStream) {
      const data = await upRes.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return sendJson(res, 200, {
        output_text: text,
        output: [
          {
            type: "message",
            content: [{ type: "text", text }],
          },
        ],
      });
    }

    // 流式响应适配 (将 chat.completion.chunk 适配为 response.output_text.delta)
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let fullText = "";
    const reader = upRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === "[DONE]") continue;

        try {
          const json = JSON.parse(dataStr);
          const delta = json?.choices?.[0]?.delta?.content || "";
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
          }
        } catch {}
      }
    }

    res.write(`data: ${JSON.stringify({ type: "response.completed", response: { output_text: fullText } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    console.error("[BFF] 处理 /responses 失败:", err.message);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { message: err.message } });
    }
  }
}

// 通用代理转发
async function handleProxy(req, res) {
  const upstreamTarget = `${UPSTREAM_URL}${req.url}`;
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === "host" || k === "authorization") continue;
    headers[k] = v;
  }
  headers["Authorization"] = `Bearer ${UPSTREAM_KEY}`;

  let body = undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = Readable.toWeb(req);
  }

  try {
    const upRes = await fetch(upstreamTarget, {
      method: req.method,
      headers,
      body,
      duplex: "half",
      signal: AbortSignal.timeout(120000),
    });

    const resHeaders = { ...CORS_HEADERS };
    for (const [k, v] of upRes.headers.entries()) {
      if (k.toLowerCase() === "transfer-encoding") continue;
      resHeaders[k] = v;
    }

    res.writeHead(upRes.status, resHeaders);
    if (upRes.body) {
      Readable.fromWeb(upRes.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    console.error("[BFF] 代理转发失败:", err.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `代理转发错误: ${err.message}` } });
    }
  }
}

// 主 HTTP 路由调度器
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  if (pathname === "/" || pathname === "/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "infinite-canvas-bff",
      upstream: UPSTREAM_URL,
      maxRetries: MAX_RETRIES,
      maxConcurrent: MAX_CONCURRENT,
    });
  }

  // 1. 本地图片直链
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/images/")) {
    const filename = pathname.replace(/^\/images\//, "");
    return serveImage(req, res, filename);
  }

  // 2. 模型列表接口
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    return sendJson(res, 200, { object: "list", data: SUPPORTED_MODELS });
  }

  // 3. 文生图接口
  if (req.method === "POST" && (pathname === "/v1/images/generations" || pathname === "/images/generations")) {
    return handleGenerate(req, res);
  }

  // 4. 图生图接口
  if (req.method === "POST" && (pathname === "/v1/images/edits" || pathname === "/images/edits")) {
    return handleEdits(req, res);
  }

  // 5. 文本与推理调用转换接口
  if (pathname.startsWith("/v1/responses") || pathname.startsWith("/responses")) {
    return handleResponses(req, res);
  }

  // 6. 其他通用请求 (如 /v1/chat/completions 等) 走透明反向代理
  return handleProxy(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[BFF] Server running on http://0.0.0.0:${PORT} (Upstream: ${UPSTREAM_URL}, Retries: ${MAX_RETRIES}, Concurrent: ${MAX_CONCURRENT})`);
});
