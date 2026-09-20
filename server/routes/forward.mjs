import { Readable } from "node:stream";

import * as upstream from "../channels/upstream.mjs";
import { getChannel, resolveModel } from "../channels/index.mjs";
import { config } from "../config.mjs";
import { badGateway } from "../lib/errors.mjs";

const MAX_FORWARD_BODY = 10 * 1024 * 1024;

// 非生图请求（文本 / 视频 / 音频 / 对话等）统一透传到上游渠道。
// 前端模型名为 `渠道/模型`，转发前去除渠道前缀，保证上游拿到原始模型名。
export async function handleForward({ req, res, pathname, search }) {
  const hasBody = !["GET", "HEAD"].includes(req.method || "GET");
  const streaming = String(req.headers.accept || "").includes("text/event-stream");
  const body = hasBody ? await readBody(req) : undefined;

  let response;
  try {
    response = await fetch(`${config.upstream.baseUrl}${pathname}${search || ""}`, {
      method: req.method,
      headers: upstream.forwardHeaders(req.headers, Buffer.isBuffer(body) ? body.length : 0),
      body,
      signal: streaming ? undefined : AbortSignal.timeout(config.forwardTimeoutMs),
    });
  } catch (error) {
    throw badGateway(`上游请求失败: ${error.message}`);
  }

  res.writeHead(response.status, { ...streamHeaders(response.headers), "Access-Control-Allow-Origin": "*" });
  if (!response.body || req.method === "HEAD") return res.end();
  Readable.fromWeb(response.body).pipe(res);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORWARD_BODY) throw badGateway("转发请求体过大", "PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return stripChannelPrefix(buffer, req.headers["content-type"]);
}

// 仅对 JSON 正文改写 model 字段，其他类型（multipart 等）原样透传
function stripChannelPrefix(buffer, contentType) {
  if (!buffer.length || !String(contentType || "").includes("application/json")) return buffer;
  try {
    const payload = JSON.parse(buffer.toString("utf8"));
    if (typeof payload?.model === "string" && payload.model.includes("/")) {
      const { channelId, model } = resolveModel(payload.model);
      if (getChannel(channelId)) payload.model = model;
    }
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return buffer;
  }
}

function streamHeaders(headers) {
  const result = {};
  for (const [key, value] of headers.entries()) {
    if (["transfer-encoding", "connection", "content-encoding", "content-length"].includes(key.toLowerCase())) continue;
    result[key] = value;
  }
  return result;
}
