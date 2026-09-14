import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

// ==========================================
// 1. 全局配置与常量
// ==========================================
const PORT = 8000;
const BACKUP_DIR = "/app/data/images";
const UPSTREAM_URL = (process.env.UPSTREAM_URL || "http://localhost:3000").replace(/\/+$/, "");
const UPSTREAM_KEY = process.env.UPSTREAM_KEY || "";
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1500);
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT || 10);
const STAGGER_INTERVAL_MS = Number(process.env.STAGGER_INTERVAL_MS || 1000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 45000);
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS || 45000);

// 支持的模型列表（供前端读取展示）
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

// 确保图片本地持久化目录就绪
fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});

// ==========================================
// 2. 基础工具与并发队列
// ==========================================

// JSON 快捷响应
function sendJson(res, statusCode, data) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

// 动态推导图片 MIME 类型
function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
  return map[ext] || "image/jpeg";
}

// 画幅比例注入（识别 size 并推导 --ar 1:1 / 16:9 等）
function injectAspectRatio(prompt, size) {
  if (!size || typeof size !== "string" || /--ar\s+\d+:\d+/i.test(prompt)) return prompt;
  const [w, h] = size.split("x").map(Number);
  if (!w || !h) return prompt;
  const ratio = w / h;
  const ratios = [
    [16 / 9, "16:9"], [9 / 16, "9:16"], [4 / 3, "4:3"],
    [3 / 4, "3:4"], [1, "1:1"], [21 / 9, "21:9"]
  ];
  const matched = ratios.find(([r]) => Math.abs(ratio - r) < 0.05);
  return matched ? `${prompt.trim()} --ar ${matched[1]}` : prompt;
}

// 严格绘图指令包装（强制模型必须输出图片，严禁闲聊、解释或回复普通文本）
function formatImagePrompt(rawPrompt) {
  const p = (rawPrompt || "").trim();
  if (/^(draw|generate|create|render)\s+an?\s+image/i.test(p)) {
    return p;
  }
  return `Generate an image depicting: "${p}". Do not chat, explain, or output text. Directly invoke the image generation tool.`;
}

// 保存 Base64 图片数据到本地持久化目录
async function saveBase64Image(b64Str) {
  const cleanB64 = b64Str.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
  const buf = Buffer.from(cleanB64, "base64");
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.jpg`;
  const dest = path.join(BACKUP_DIR, filename);
  await fs.writeFile(dest, buf);
  console.log(`[持久化] Base64 图片已成功保存至: ${dest}`);
  return `/images/${filename}`;
}

// 统一图片解析器：支持 message.images 数组、Markdown URL、裸 URL 与 Base64 数据
async function resolveImageResult(message) {
  if (!message) return null;

  // 1. 优先检查 message.images 数组（New-API / OpenAI 格式生图标准字段）
  if (Array.isArray(message.images) && message.images.length > 0) {
    for (const item of message.images) {
      const candidate = item?.image_url?.url || item?.url || item?.b64_json;
      if (candidate && typeof candidate === "string") {
        if (candidate.startsWith("data:image/") || candidate.startsWith("/9j/")) {
          return await saveBase64Image(candidate);
        }
        if (/^https?:\/\//i.test(candidate)) {
          return rewriteImageUrl(candidate);
        }
      }
    }
  }

  // 2. 检查 message.content
  let content = message.content;
  if (typeof content === "object" && content !== null) {
    content = content.content || content.image || content.url || content.b64_json || content.data || JSON.stringify(content);
  }

  if (typeof content !== "string" || !content.trim()) return null;

  // 3. Markdown 链接 ![...](url)
  const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
  if (mdMatch) return rewriteImageUrl(mdMatch[1]);

  // 4. Markdown 格式的 Base64 图片
  const mdB64 = content.match(/!\[.*?\]\((data:image\/[a-zA-Z]+;base64,[^\s\)]+)\)/);
  if (mdB64) return await saveBase64Image(mdB64[1]);

  // 5. HTTP(S) URL
  const urlMatch = content.match(/(https?:\/\/[^\s"'<>]+\.(?:png|jpg|jpeg|webp|gif)(?:\?[^\s"'<>]*)?)/i);
  if (urlMatch) return rewriteImageUrl(urlMatch[1]);

  const rawUrl = content.trim().match(/^https?:\/\/[^\s]+$/)?.[0];
  if (rawUrl) return rewriteImageUrl(rawUrl);

  // 6. 纯 Base64 图片数据
  const trimmed = content.trim();
  if (trimmed.startsWith("data:image/") || trimmed.startsWith("/9j/") || (trimmed.length > 200 && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed.slice(0, 100)))) {
    return await saveBase64Image(trimmed);
  }

  return null;
}

// 防内存泄漏的容量限制 Map
class BoundedMap {
  constructor(max = 2000) {
    this.max = max;
    this.map = new Map();
  }
  set(k, v) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(k, v);
  }
  get(k) { return this.map.get(k); }
  delete(k) { this.map.delete(k); }
}
const imageUpstreamMap = new BoundedMap(2000);

// 标准无死锁并发队列 (参考 gemini-studio)
class ConcurrencyQueue {
  constructor(max = 10) {
    this.max = max;
    this.active = 0;
    this.waiting = [];
  }
  async acquire() {
    if (this.active < this.max) {
      this.active++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve(() => this.release());
      });
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
const queue = new ConcurrencyQueue(MAX_CONCURRENT);

// 指数退避与抖动重试控制
async function withRetry(fn, taskName, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      console.warn(`[重试] ${taskName} 第 ${attempt}/${maxRetries} 次失败: ${err.message}`);
      if (attempt < maxRetries) {
        const jitter = Math.floor(Math.random() * 600) + 200;
        const delay = RETRY_DELAY_MS * attempt + jitter;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// ==========================================
// 3. 图片本地持久化与流式服务
// ==========================================

// 异步持久化到磁盘
async function backupImage(filename, originalUrl) {
  const dest = path.join(BACKUP_DIR, filename);
  try {
    await fs.access(dest);
    imageUpstreamMap.delete(filename);
    return;
  } catch {}
  try {
    const res = await fetch(originalUrl, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) return;
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    imageUpstreamMap.delete(filename);
    console.log(`[持久化] 图片已安全保存至: ${dest}`);
  } catch (err) {
    console.warn(`[持久化] 异步下载备份失败 (${originalUrl}):`, err.message);
  }
}

// 改写上游 URL 为本地服务直链
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

// 本地图片只读流直出服务
async function serveImage(req, res, filename) {
  const safeFilename = path.basename(filename);
  const localPath = path.join(BACKUP_DIR, safeFilename);
  const contentType = getMimeType(safeFilename);

  // 1. 本地缓存命中，只读流毫秒直出
  try {
    const stat = await fs.stat(localPath);
    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=604800, immutable",
    });
    if (req.method === "HEAD") return res.end();
    return fsSync.createReadStream(localPath).pipe(res);
  } catch {}

  // 2. 本地未命中，向上游实时拉取并写盘
  const upstreamUrl = imageUpstreamMap.get(safeFilename) || (UPSTREAM_URL ? `${UPSTREAM_URL}/images/${safeFilename}` : "");
  if (!upstreamUrl) return sendJson(res, 404, { error: "Image not found" });

  try {
    const upRes = await fetch(upstreamUrl, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!upRes.ok) return sendJson(res, upRes.status, { error: "Image not found on upstream" });
    const buf = Buffer.from(await upRes.arrayBuffer());
    fs.writeFile(localPath, buf).then(() => imageUpstreamMap.delete(safeFilename)).catch(() => {});

    res.writeHead(200, {
      ...CORS_HEADERS,
      "Content-Type": contentType,
      "Content-Length": buf.length,
      "Cache-Control": "public, max-age=604800, immutable",
    });
    if (req.method === "HEAD") return res.end();
    res.end(buf);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 502, { error: `拉取上游图片失败: ${err.message}` });
  }
}

// ==========================================
// 4. 业务处理：文生图、图生图、文本/推理
// ==========================================

// 单次生图调用（注入系统提示词，防止 Gemini 闲聊）
async function requestUpstreamImage(messages, model, taskName) {
  const release = await queue.acquire();
  try {
    return await withRetry(async () => {
      const upRes = await fetch(`${UPSTREAM_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${UPSTREAM_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages, stream: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!upRes.ok) throw new Error(`上游 HTTP ${upRes.status}: ${(await upRes.text()).slice(0, 150)}`);

      const data = await upRes.json();
      const choice = data?.choices?.[0];
      const imgUrl = await resolveImageResult(choice?.message);

      if (!imgUrl) {
        const finishReason = choice?.finish_reason || "unknown";
        const contentStr = JSON.stringify(choice?.message || "");
        console.warn(`[BFF] 生图未出图: finish_reason=${finishReason}, message="${contentStr.slice(0, 100)}"`);
        throw new Error(`上游未返回有效图片 (finish_reason: ${finishReason})`);
      }
      return imgUrl;
    }, taskName, MAX_RETRIES);
  } finally {
    release();
  }
}

// POST /v1/images/generations 文生图
async function handleGenerate(req, res) {
  let body = {};
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const model = body.model || "gemini-3.1-flash-image";
  const rawPrompt = body.prompt || "";
  const formattedPrompt = formatImagePrompt(rawPrompt);
  const prompt = injectAspectRatio(formattedPrompt, body.size);
  const count = Math.max(1, Math.min(10, Number(body.n) || 1));
  const messages = [{ role: "user", content: prompt }];

  console.log(`[BFF] 文生图请求: model=${model}, count=${count}, prompt="${rawPrompt.slice(0, 45)}..."`);

  try {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_INTERVAL_MS));
      tasks.push(requestUpstreamImage(messages, model, `生图任务 #${i + 1}`));
    }
    const urls = await Promise.all(tasks);
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) });
  } catch (err) {
    console.error("[BFF] 生图最终失败:", err.message);
    sendJson(res, 500, { error: { message: err.message || "生图失败" } });
  }
}

// POST /v1/images/edits 图生图 / 编辑
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
    const formattedPrompt = formatImagePrompt(rawPrompt);
    const prompt = injectAspectRatio(formattedPrompt, (formData.get("size") || "").toString());
    const count = Math.max(1, Math.min(10, Number(formData.get("n")) || 1));

    const imageParts = [];
    for (const [k, v] of formData.entries()) {
      if ((k === "image" || k === "image[]") && typeof v === "object" && typeof v.arrayBuffer === "function") {
        const b64 = `data:${v.type || "image/png"};base64,${Buffer.from(await v.arrayBuffer()).toString("base64")}`;
        imageParts.push({ type: "image_url", image_url: { url: b64 } });
      }
    }

    const messages = [
      { role: "user", content: [{ type: "text", text: prompt }, ...imageParts] },
    ];

    console.log(`[BFF] 图生图请求: model=${model}, refImages=${imageParts.length}, prompt="${prompt.slice(0, 45)}..."`);

    const tasks = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_INTERVAL_MS));
      tasks.push(requestUpstreamImage(messages, model, `图生图任务 #${i + 1}`));
    }
    const urls = await Promise.all(tasks);
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) });
  } catch (err) {
    console.error("[BFF] 图生图最终失败:", err.message);
    sendJson(res, 500, { error: { message: err.message || "图生图失败" } });
  }
}

// POST /v1/responses 前端画布流式文本与推理适配
async function handleResponses(req, res) {
  let body = {};
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
  } catch {}

  const model = body.model || "gemini-3.8-flash";
  const messages = Array.isArray(body.input)
    ? body.input.map((item) => ({
        role: item.role || "user",
        content: typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map((c) => c.text || "").join("") : "",
      }))
    : [{ role: "user", content: String(body.input || "") }];

  const isStream = Boolean(body.stream);
  try {
    const upRes = await fetch(`${UPSTREAM_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTREAM_KEY}`, "Content-Type": "application/json", ...(isStream ? { Accept: "text/event-stream" } : {}) },
      body: JSON.stringify({ model, messages, stream: isStream }),
      signal: AbortSignal.timeout(120000),
    });

    if (!upRes.ok) return sendJson(res, upRes.status, { error: { message: await upRes.text() } });

    // 非流式返回
    if (!isStream) {
      const data = await upRes.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return sendJson(res, 200, { output_text: text, output: [{ type: "message", content: [{ type: "text", text }] }] });
    }

    // 流式返回：将 chat.completion.chunk 转换为 response.output_text.delta
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });

    const reader = upRes.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:") || trimmed.slice(5).trim() === "[DONE]") continue;
          try {
            const delta = JSON.parse(trimmed.slice(5).trim())?.choices?.[0]?.delta?.content || "";
            if (delta) {
              fullText += delta;
              res.write(`data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`);
            }
          } catch {}
        }
      }
      res.write(`data: ${JSON.stringify({ type: "response.completed", response: { output_text: fullText } })}\n\n`);
      res.write("data: [DONE]\n\n");
    } finally {
      if (!res.writableEnded) res.end();
    }
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: { message: err.message } });
  }
}

// 透明反向代理（其他 OpenAI 接口转发）
async function handleProxy(req, res) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k !== "host" && k !== "authorization") headers[k] = v;
  }
  headers["Authorization"] = `Bearer ${UPSTREAM_KEY}`;

  try {
    const upRes = await fetch(`${UPSTREAM_URL}${req.url}`, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? Readable.toWeb(req) : undefined,
      duplex: "half",
      signal: AbortSignal.timeout(120000),
    });
    const resHeaders = { ...CORS_HEADERS };
    for (const [k, v] of upRes.headers.entries()) {
      if (k.toLowerCase() !== "transfer-encoding") resHeaders[k] = v;
    }
    res.writeHead(upRes.status, resHeaders);
    if (upRes.body) Readable.fromWeb(upRes.body).pipe(res);
    else res.end();
  } catch (err) {
    if (!res.headersSent) sendJson(res, 502, { error: { message: `代理转发错误: ${err.message}` } });
  }
}

// ==========================================
// 5. HTTP 服务入口与路由分发
// ==========================================
const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  const { pathname } = new URL(req.url, "http://localhost");

  // 健康探活
  if (pathname === "/" || pathname === "/health") {
    return sendJson(res, 200, { status: "ok", service: "infinite-canvas-bff", upstream: UPSTREAM_URL });
  }
  // 本地图片直出
  if ((req.method === "GET" || req.method === "HEAD") && pathname.startsWith("/images/")) {
    return serveImage(req, res, pathname.replace(/^\/images\//, ""));
  }
  // 模型列表
  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    return sendJson(res, 200, { object: "list", data: SUPPORTED_MODELS });
  }
  // 文生图
  if (req.method === "POST" && (pathname === "/v1/images/generations" || pathname === "/images/generations")) {
    return handleGenerate(req, res);
  }
  // 图生图
  if (req.method === "POST" && (pathname === "/v1/images/edits" || pathname === "/images/edits")) {
    return handleEdits(req, res);
  }
  // 画布文本/推理流式
  if (pathname.startsWith("/v1/responses") || pathname.startsWith("/responses")) {
    return handleResponses(req, res);
  }
  // 其他通用代理转发
  return handleProxy(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[BFF] Server running on http://0.0.0.0:${PORT} (Upstream: ${UPSTREAM_URL}, Retries: ${MAX_RETRIES}, Concurrent: ${MAX_CONCURRENT})`);
});
