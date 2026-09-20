import { badRequest } from "./errors.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export function sendJson(res, status, payload, headers = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...headers,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// 统一错误输出：兼容 OpenAI 风格 { error: { message, code } }
export function sendError(res, error) {
  const status = Number(error?.status) || 500;
  const code = error?.code || "INTERNAL_ERROR";
  const message = error?.message || "服务器内部错误";
  sendJson(res, status, { error: { message, code } });
}

export async function readJsonBody(req, limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw badRequest("请求体过大", "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest("请求体不是合法 JSON", "INVALID_JSON");
  }
}
