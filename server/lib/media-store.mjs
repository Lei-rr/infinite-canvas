import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";

import { config } from "../config.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger("media");

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};
const EXT_BY_MIME = { "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "image/svg+xml": ".svg", "image/jpeg": ".jpg", "video/mp4": ".mp4", "audio/mpeg": ".mp3" };

// 媒体响应允许的内容类型：上游未命中时返回 HTML 页面（状态仍为 200），必须按类型过滤
const MEDIA_CONTENT_TYPES = ["image/", "video/", "audio/", "application/octet-stream"];

function isMediaResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  return MEDIA_CONTENT_TYPES.some((prefix) => contentType.startsWith(prefix));
}

// 文件名 -> 源站地址，用于本地文件缺失时回源补拉，避免上游临时链接过期后丢图
const remoteSources = new Map();
const REMOTE_SOURCE_LIMIT = 5000;

function rememberRemote(filename, url) {
  if (remoteSources.size >= REMOTE_SOURCE_LIMIT) remoteSources.delete(remoteSources.keys().next().value);
  remoteSources.set(filename, url);
}

function mediaMime(filename) {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || "application/octet-stream";
}

function mediaPath(filename) {
  return path.join(config.mediaDir, path.basename(filename));
}

function buildFilename(ext) {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}${ext}`;
}

function guessExt(url) {
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if (MIME_BY_EXT[ext]) return ext;
  } catch {}
  return ".jpg";
}

export async function ensureDirs() {
  await Promise.all([
    fs.mkdir(config.mediaDir, { recursive: true }),
    fs.mkdir(config.authDir, { recursive: true }),
  ]);
}

// 持久化 Base64 媒体，返回站内可访问路径
export async function saveBase64Media(payload) {
  const match = /^data:(?<mime>[\w.+-]+\/[\w.+-]+);base64,(?<data>.*)$/s.exec(payload);
  const mime = match?.groups?.mime || "image/jpeg";
  const base64 = (match?.groups?.data || payload).replace(/\s+/g, "");
  const filename = buildFilename(EXT_BY_MIME[mime] || path.extname(mime) || ".jpg");
  await fs.writeFile(mediaPath(filename), Buffer.from(base64, "base64"));
  return `/images/${filename}`;
}

// 下载远程媒体到本地并返回站内路径；失败抛出，由上层决定是否回退
export async function downloadMedia(url, { timeoutMs = config.mediaTimeoutMs } = {}) {
  const filename = buildFilename(guessExt(url));
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !isMediaResponse(response)) throw new Error(`下载媒体失败: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("下载媒体失败: 内容为空");
  await fs.writeFile(mediaPath(filename), buffer);
  return `/images/${filename}`;
}

// 后台把远程链接转为本地文件：先返回站内路径占位，下载完成后自动命中本地文件
export function persistRemoteMedia(url) {
  const filename = buildFilename(guessExt(url));
  rememberRemote(filename, url);
  void downloadTo(filename, url);
  return `/images/${filename}`;
}

async function downloadTo(filename, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(config.mediaTimeoutMs) });
    if (!response.ok || !isMediaResponse(response)) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) throw new Error("内容为空");
    await fs.writeFile(mediaPath(filename), buffer);
    remoteSources.delete(filename);
    log.info(`已缓存远程媒体 ${filename}`);
  } catch (error) {
    log.warn(`远程媒体缓存失败 ${url}: ${error.message}`);
  }
}

// 本地文件直出；缺失时按记录的源站地址补拉一次，仍失败则回源上游 /images 兜底
export async function serveMedia(req, res, rawFilename) {
  const filename = path.basename(rawFilename);
  const filePath = mediaPath(filename);

  const cached = await statFile(filePath);
  if (cached) return streamFile(req, res, filePath, cached.size, mediaMime(filename));

  const source = remoteSources.get(filename);
  if (source) {
    await downloadTo(filename, source);
    const downloaded = await statFile(filePath);
    if (downloaded) return streamFile(req, res, filePath, downloaded.size, mediaMime(filename));
  }

  try {
    const response = await fetch(`${config.upstream.baseUrl}/images/${encodeURIComponent(filename)}`, { signal: AbortSignal.timeout(config.mediaTimeoutMs) });
    if (response.ok && isMediaResponse(response)) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length) {
        await fs.writeFile(filePath, buffer).catch(() => {});
        return sendBuffer(req, res, buffer, response.headers.get("content-type") || mediaMime(filename));
      }
    }
  } catch (error) {
    log.warn(`图片回源失败 ${filename}: ${error.message}`);
  }
  return null;
}

async function statFile(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return null;
  }
}

function streamFile(req, res, filePath, size, contentType) {
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": contentType,
    "Content-Length": size,
    "Cache-Control": "public, max-age=604800, immutable",
  });
  if (req.method === "HEAD") return res.end();
  fsSync.createReadStream(filePath).pipe(res);
}

function sendBuffer(req, res, buffer, contentType) {
  res.writeHead(200, {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": contentType,
    "Content-Length": buffer.length,
    "Cache-Control": "public, max-age=604800, immutable",
  });
  if (req.method === "HEAD") return res.end();
  res.end(buffer);
}
