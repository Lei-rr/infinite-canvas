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
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90000);
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS || 45000);

const DEFAULT_IMAGE_MODEL = process.env.IMAGE_MODEL || "gemini-3.1-flash-image";
const DEFAULT_MODELS_STR = "gemini-3.1-flash-image,gemini-3.1-flash-image-2K,gemini-3.1-flash-image-4K,gpt-image-2";
const SUPPORTED_MODELS = (process.env.MODELS || DEFAULT_MODELS_STR)
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean)
  .map((id) => ({ id, object: "model" }));

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// 确保图片本地持久化目录就绪
fs.mkdir(BACKUP_DIR, { recursive: true }).catch(() => {});

// ==========================================
// 2. 核心存储与本地持久化模块 (Storage Service)
// ==========================================
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

function sendJson(res, statusCode, data) {
  if (res.writableEnded) return;
  res.writeHead(statusCode, { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function getMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const mimeMap = { ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml" };
  return mimeMap[ext] || "image/jpeg";
}

// 异步持久化 Base64 图片
async function saveBase64Image(b64Str) {
  const cleanB64 = b64Str.replace(/^data:image\/[a-zA-Z]+;base64,/, "");
  const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 9)}.jpg`;
  const dest = path.join(BACKUP_DIR, filename);
  await fs.writeFile(dest, Buffer.from(cleanB64, "base64"));
  console.log(`[持久化] Base64 图片已成功保存至: ${dest}`);
  return `/images/${filename}`;
}

// 异步下载远程图片写盘
async function backupRemoteImage(filename, remoteUrl) {
  const dest = path.join(BACKUP_DIR, filename);
  try {
    await fs.access(dest);
    imageUpstreamMap.delete(filename);
    return;
  } catch {}
  try {
    const res = await fetch(remoteUrl, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    if (!res.ok) return;
    await fs.writeFile(dest, Buffer.from(await res.arrayBuffer()));
    imageUpstreamMap.delete(filename);
    console.log(`[持久化] 远程图片已下载保存至: ${dest}`);
  } catch (err) {
    console.warn(`[持久化] 异步下载备份失败 (${remoteUrl}):`, err.message);
  }
}

// 改写图片直链
function rewriteImageUrl(originalUrl) {
  if (!originalUrl) return "";
  try {
    const filename = path.basename(new URL(originalUrl).pathname);
    imageUpstreamMap.set(filename, originalUrl);
    backupRemoteImage(filename, originalUrl);
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

  // 1. 本地缓存命中秒出
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

  // 2. 未命中时回源拉取
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
// 3. 并发调度与重试控制 (Queue & Retry)
// ==========================================
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
// 4. 适配器模式生图引擎 (Image Engine Adapters)
// ==========================================

// 画幅比例注入 (--ar 1:1, 16:9 等)
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

// 严格绘图指令包装（消除 Gemini 口语闲聊）
function formatImagePrompt(rawPrompt) {
  const p = (rawPrompt || "").trim();
  if (/^(draw|generate|create|render)\s+an?\s+image/i.test(p)) return p;
  return `Generate an image depicting: "${p}". Do not chat, explain, or output text. Directly invoke the image generation tool.`;
}

// 多格式图片响应提取解析器 (支持 message.images 数组、Markdown URL、裸 URL、Base64)
async function resolveImageResult(message) {
  if (!message) return null;

  // 1. 优先解析 new-api 返回的 message.images 数组
  if (Array.isArray(message.images) && message.images.length > 0) {
    for (const item of message.images) {
      const candidate = item?.image_url?.url || item?.url || item?.b64_json;
      if (candidate && typeof candidate === "string") {
        if (candidate.startsWith("data:image/") || candidate.startsWith("/9j/")) {
          return await saveBase64Image(candidate);
        }
        if (/^https?:\/\//i.test(candidate)) return rewriteImageUrl(candidate);
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

  // 5. 常见 HTTP(S) URL
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

// 策略 A: OpenAI 标准图片接口适配器 (用于 gpt-image-2 等标准生图模型)
async function dispatchOpenAiImage({ model, prompt, size }) {
  const upRes = await fetch(`${UPSTREAM_URL}/v1/images/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTREAM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt, size: size || "1024x1024", n: 1 }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!upRes.ok) throw new Error(`OpenAI HTTP ${upRes.status}: ${(await upRes.text()).slice(0, 150)}`);
  const data = await upRes.json();
  const imgUrl = data?.data?.[0]?.url;
  if (!imgUrl) throw new Error("上游未返回有效图片地址");
  return rewriteImageUrl(imgUrl);
}

// 策略 B: Gemini 对话生图转译适配器 (用于 gemini-3.1-flash-image 系列)
async function dispatchGeminiChatImage({ model, prompt, size, refImages }) {
  const formattedPrompt = formatImagePrompt(prompt);
  const fullPrompt = injectAspectRatio(formattedPrompt, size);
  const userContent = refImages && refImages.length > 0
    ? [{ type: "text", text: fullPrompt }, ...refImages]
    : fullPrompt;

  const upRes = await fetch(`${UPSTREAM_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTREAM_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: userContent }], stream: false }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!upRes.ok) throw new Error(`Gemini HTTP ${upRes.status}: ${(await upRes.text()).slice(0, 150)}`);
  const data = await upRes.json();
  const choice = data?.choices?.[0];
  const imgUrl = await resolveImageResult(choice?.message);

  if (!imgUrl) {
    const finishReason = choice?.finish_reason || "unknown";
    const msgStr = JSON.stringify(choice?.message || "");
    console.warn(`[BFF] 生图未出图: finish_reason=${finishReason}, message="${msgStr.slice(0, 80)}"`);
    throw new Error(`上游未返回有效图片 (finish_reason: ${finishReason})`);
  }
  return imgUrl;
}

// 统一生图管道调度核心
async function executeSingleImageTask({ model, prompt, size, refImages, taskName }) {
  const release = await queue.acquire();
  try {
    return await withRetry(async () => {
      // 策略选择：gpt-image-2 走原生 OpenAI 图片接口，其余走 Gemini 多模态对话转译
      if (model === "gpt-image-2" || model.startsWith("dall-e")) {
        return await dispatchOpenAiImage({ model, prompt, size });
      }
      return await dispatchGeminiChatImage({ model, prompt, size, refImages });
    }, taskName, MAX_RETRIES);
  } finally {
    release();
  }
}

// ==========================================
// 5. 业务请求分发与协议适配 (Handlers)
// ==========================================

// 文生图接口 POST /v1/images/generations
async function handleGenerate(req, res) {
  let body = {};
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const model = body.model || DEFAULT_IMAGE_MODEL;
  const prompt = body.prompt || "";
  const size = body.size;
  const count = Math.max(1, Math.min(10, Number(body.n) || 1));

  console.log(`[BFF] 文生图请求: model=${model}, count=${count}, prompt="${prompt.slice(0, 45)}..."`);

  try {
    const tasks = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_INTERVAL_MS));
      tasks.push(executeSingleImageTask({ model, prompt, size, taskName: `生图任务 #${i + 1}` }));
    }
    const urls = await Promise.all(tasks);
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) });
  } catch (err) {
    console.error("[BFF] 生图失败:", err.message);
    sendJson(res, 500, { error: { message: err.message || "生图失败" } });
  }
}

// 图生图 / 编辑接口 POST /v1/images/edits
async function handleEdits(req, res) {
  try {
    const webReq = new Request("http://localhost" + req.url, {
      method: req.method,
      headers: req.headers,
      body: Readable.toWeb(req),
      duplex: "half",
    });
    const formData = await webReq.formData();
    const model = (formData.get("model") || DEFAULT_IMAGE_MODEL).toString();
    const prompt = (formData.get("prompt") || "").toString();
    const size = (formData.get("size") || "").toString();
    const count = Math.max(1, Math.min(10, Number(formData.get("n")) || 1));

    const refImages = [];
    for (const [k, v] of formData.entries()) {
      if ((k === "image" || k === "image[]") && typeof v === "object" && typeof v.arrayBuffer === "function") {
        const b64 = `data:${v.type || "image/png"};base64,${Buffer.from(await v.arrayBuffer()).toString("base64")}`;
        refImages.push({ type: "image_url", image_url: { url: b64 } });
      }
    }

    console.log(`[BFF] 图生图请求: model=${model}, refImages=${refImages.length}, prompt="${prompt.slice(0, 45)}..."`);

    const tasks = [];
    for (let i = 0; i < count; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, STAGGER_INTERVAL_MS));
      tasks.push(executeSingleImageTask({ model, prompt, size, refImages, taskName: `图生图任务 #${i + 1}` }));
    }
    const urls = await Promise.all(tasks);
    sendJson(res, 200, { created: Math.floor(Date.now() / 1000), data: urls.map((url) => ({ url })) });
  } catch (err) {
    console.error("[BFF] 图生图失败:", err.message);
    sendJson(res, 500, { error: { message: err.message || "图生图失败" } });
  }
}

// 文本与推理适配接口 POST /v1/responses
async function handleResponses(req, res) {
  let body = {};
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    body = JSON.parse(raw);
  } catch {}

  const model = "gemini-3.8-flash";
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

    if (!isStream) {
      const data = await upRes.json();
      const text = data?.choices?.[0]?.message?.content || "";
      return sendJson(res, 200, { output_text: text, output: [{ type: "message", content: [{ type: "text", text }] }] });
    }

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

// 通用反向代理（转发其他兼容接口）
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
// 6. HTTP 服务路由调度器
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
  // 画布文本/推理流式与非流式问答
  if (pathname.startsWith("/v1/responses") || pathname.startsWith("/responses")) {
    return handleResponses(req, res);
  }
  // 通用代理
  return handleProxy(req, res);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[BFF] Server running on http://0.0.0.0:${PORT} (Upstream: ${UPSTREAM_URL}, Retries: ${MAX_RETRIES}, Concurrent: ${MAX_CONCURRENT})`);
});
