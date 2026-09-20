import { collectModels } from "../channels/index.mjs";
import { config } from "../config.mjs";
import { notFound } from "../lib/errors.mjs";
import { readJsonBody, sendJson } from "../lib/http.mjs";
import { serveMedia } from "../lib/media-store.mjs";
import { handleEdits, handleGenerate } from "./images.mjs";
import { handleForward } from "./forward.mjs";

// 模型列表短时缓存：避免前端每次打开页面都请求上游
const modelCache = { at: 0, models: [] };

async function modelsPayload() {
  if (Date.now() - modelCache.at < config.modelCacheMs && modelCache.models.length) {
    return { object: "list", data: modelCache.models };
  }
  const models = await collectModels((channel) => channel.listModels());
  modelCache.at = Date.now();
  modelCache.models = models;
  return { object: "list", data: models };
}

// 路由优先级：本地模型与生图接口 -> 本地媒体 -> 其余 /v1 透传上游
export async function dispatch(ctx) {
  const { req, res, pathname } = ctx;

  if (req.method === "GET" && pathname === "/v1/models") {
    return sendJson(res, 200, await modelsPayload());
  }

  if (req.method === "GET" && pathname === "/health") {
    return sendJson(res, 200, { status: "ok", service: "infinite-canvas-bff", upstream: config.upstream.id });
  }

  if (pathname.startsWith("/images/")) {
    const served = await serveMedia(req, res, pathname.slice("/images/".length));
    if (served === null && !res.headersSent) {
      return sendJson(res, 404, { error: { message: "图片不存在", code: "MEDIA_NOT_FOUND" } });
    }
    return undefined;
  }

  if (req.method === "POST" && pathname === "/v1/images/generations") {
    const body = await readJsonBody(req);
    return sendJson(res, 200, await handleGenerate({ ...ctx, body }));
  }

  if (req.method === "POST" && pathname === "/v1/images/edits") {
    return sendJson(res, 200, await handleEdits(ctx));
  }

  if (pathname.startsWith("/v1/")) {
    return handleForward(ctx);
  }

  throw notFound(`未定义的路径: ${pathname}`, "ROUTE_NOT_FOUND");
}
