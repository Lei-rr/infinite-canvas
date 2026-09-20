import { persistRemoteMedia, saveBase64Media } from "./media-store.mjs";

const BASE64_HINT = /^[A-Za-z0-9+/=\r\n]{200,}$/;

// 各渠道返回图片的形态差异较大（images 数组 / markdown / 裸链接 / base64），统一在这里归一为站内路径。
export async function extractImageUrl(message) {
  if (!message) return "";

  if (Array.isArray(message.images)) {
    const hit = message.images.map((item) => item?.image_url?.url || item?.url || item?.b64_json).find((value) => typeof value === "string" && value);
    if (hit) return store(hit);
  }

  let content = message.content;
  if (content && typeof content === "object") {
    content = content.content || content.image || content.url || content.b64_json || content.data || "";
  }
  if (typeof content !== "string" || !content.trim()) return "";
  const text = content.trim();

  const markdownB64 = text.match(/!\[[^\]]*\]\((data:image\/[\w.+-]+;base64,[^\s)]+)\)/);
  if (markdownB64) return saveBase64Media(markdownB64[1]);

  const markdownUrl = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
  if (markdownUrl) return persistRemoteMedia(markdownUrl[1]);

  const embeddedUrl = text.match(/(https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?)/i);
  if (embeddedUrl) return persistRemoteMedia(embeddedUrl[1]);

  const plainUrl = text.match(/^https?:\/\/\S+$/)?.[0];
  if (plainUrl) return persistRemoteMedia(plainUrl);

  if (text.startsWith("data:image/") || BASE64_HINT.test(text.slice(0, 256))) return saveBase64Media(text);

  return "";
}

function store(value) {
  if (value.startsWith("data:image/") || value.startsWith("/9j/")) return saveBase64Media(value);
  if (/^https?:\/\//i.test(value)) return persistRemoteMedia(value);
  return "";
}

// 把上游返回的图片结果（url / b64_json）统一转成站内路径
export async function normalizeImageResult(item) {
  const value = item?.url || item?.b64_json || item?.image_url?.url || "";
  return value ? store(value) : "";
}
