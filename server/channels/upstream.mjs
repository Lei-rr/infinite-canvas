import { config } from "../config.mjs";
import { badGateway } from "../lib/errors.mjs";
import { extractImageUrl, normalizeImageResult } from "../lib/image-result.mjs";
import { createLogger } from "../lib/logger.mjs";

const log = createLogger("channel:upstream");

export const id = config.upstream.id;
export const label = config.upstream.label;

const VIDEO_KEYWORDS = ["video", "sora", "veo", "kling", "wan", "hailuo"];
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

// 与前端 guessCapability 保持一致的模型能力推测，供模型选择器分组
function guessCapability(model) {
  const value = model.toLowerCase();
  if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
  if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
  if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
  return "text";
}

export function headers(extra = {}) {
  return {
    ...(config.upstream.apiKey ? { Authorization: `Bearer ${config.upstream.apiKey}` } : {}),
    ...extra,
  };
}

function endpoint(pathname) {
  return `${config.upstream.baseUrl}${pathname}`;
}

export async function listModels() {
  const response = await fetch(endpoint("/v1/models"), { headers: headers(), signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) throw new Error(`模型列表请求失败: HTTP ${response.status}`);
  const payload = await response.json();
  const models = (payload?.data || [])
    .map((item) => ({ id: String(item?.id || "").trim(), capability: guessCapability(String(item?.id || "")) }))
    .filter((item) => item.id);
  if (!models.length) throw new Error("模型列表为空");
  return models;
}

export function fallbackModels() {
  return config.upstream.fallbackModels.map((model) => ({ id: model, capability: guessCapability(model) }));
}

// gpt-image / dall-e 走原生图片接口，其余多模态模型走对话接口提取图片
export async function generateImage({ model, prompt, size, refImages = [] }) {
  if (model === "gpt-image-2" || model.startsWith("dall-e")) {
    return generateViaImageApi({ model, prompt, size });
  }
  return generateViaChat({ model, prompt, size, refImages });
}

async function generateViaImageApi({ model, prompt, size }) {
  const response = await fetch(endpoint("/v1/images/generations"), {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model, prompt, size: size || "1024x1024", n: 1 }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) throw badGateway(`上游生图失败: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  const payload = await response.json();
  const url = await normalizeImageResult(payload?.data?.[0]);
  if (!url) throw badGateway("上游未返回有效图片地址");
  return url;
}

async function generateViaChat({ model, prompt, size, refImages }) {
  const instruction = `Generate an image depicting: "${prompt}". Do not chat, explain, or output text. Directly invoke the image generation tool.`;
  const content = refImages.length ? [{ type: "text", text: instruction }, ...refImages] : instruction;

  const response = await fetch(endpoint("/v1/chat/completions"), {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model, messages: [{ role: "user", content }], stream: false }),
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response.ok) throw badGateway(`上游生图失败: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);

  const payload = await response.json();
  const choice = payload?.choices?.[0];
  const url = await extractImageUrl(choice?.message);
  if (!url) {
    log.warn(`未解析出图片 (model=${model}, finish_reason=${choice?.finish_reason || "unknown"})`);
    throw badGateway(`上游未返回有效图片 (finish_reason: ${choice?.finish_reason || "unknown"})`);
  }
  return url;
}

// 透传请求：注入上游凭证，剔除逐跳头部
export function forwardHeaders(incoming, contentLength = 0) {
  const headers = {};
  for (const [key, value] of Object.entries(incoming)) {
    const name = key.toLowerCase();
    if (["host", "authorization", "connection", "content-length", "transfer-encoding", "accept-encoding"].includes(name)) continue;
    headers[key] = value;
  }
  if (contentLength > 0) headers["Content-Length"] = String(contentLength);
  if (config.upstream.apiKey) headers.Authorization = `Bearer ${config.upstream.apiKey}`;
  return headers;
}
