import { config } from "../../config.mjs";
import { badGateway, unavailable } from "../../lib/errors.mjs";
import { createLogger } from "../../lib/logger.mjs";
import { downloadMedia } from "../../lib/media-store.mjs";
import { sleep } from "../../lib/retry.mjs";
import { getAccessToken, invalidateAccessToken } from "./token.mjs";

const log = createLogger("channel:l0veyou");

export const id = config.l0veyou.id;
export const label = config.l0veyou.label;

export function enabled() {
  return Boolean(config.l0veyou.accessToken || config.l0veyou.refreshToken);
}

export function listModels() {
  return config.l0veyou.models.map((model) => ({ id: model, capability: "image" }));
}

// 网页登录态异步生图：提交任务后轮询任务状态，完成后返回站内图片路径
export async function generateImage({ model, prompt, size, refImages = [] }) {
  const taskId = await submitTask({ model, prompt, size, refImages });
  return await waitForTask(taskId);
}

async function submitTask({ model, prompt, size, refImages }) {
  const body = { prompt, model, aspect_ratio: toAspectRatio(size) };
  const reference = refImages.map((item) => item?.image_url?.url).find((url) => typeof url === "string" && url);
  // 上游参考图字段只能接收单张图片字符串，多图请求取第一张
  if (reference) body.image = reference;

  const payload = await request("/api/v1/images/generate", { method: "POST", body: JSON.stringify(body) });
  const taskId = payload?.data?.id;
  if (!taskId) throw badGateway("l0veyou 未返回任务 ID");
  log.info(`已提交生图任务 ${taskId} (model=${model})`);
  return taskId;
}

async function waitForTask(taskId) {
  const deadline = Date.now() + config.l0veyou.taskTimeoutMs;
  for (;;) {
    const payload = await request(`/api/v1/images/tasks/${encodeURIComponent(taskId)}`);
    const task = payload?.data || {};
    if (task.status === "completed") {
      const urls = Array.isArray(task.image_urls) ? task.image_urls.filter(Boolean) : [];
      if (!urls.length) throw badGateway("l0veyou 任务已完成但未返回图片地址");
      return await downloadMedia(urls[0]);
    }
    if (task.status === "failed") throw badGateway(`l0veyou 生图失败: ${task.error || "未知错误"}`);
    if (Date.now() >= deadline) throw unavailable(`l0veyou 生图超时（${Math.round(config.l0veyou.taskTimeoutMs / 1000)}s）`, "TASK_TIMEOUT");
    await sleep(config.l0veyou.pollIntervalMs);
  }
}

const RATIOS = [
  [16 / 9, "16:9"], [9 / 16, "9:16"], [4 / 3, "4:3"], [3 / 4, "3:4"],
  [3 / 2, "3:2"], [2 / 3, "2:3"], [1, "1:1"],
];

function toAspectRatio(size) {
  const match = /^(\d+)x(\d+)$/.exec(String(size || ""));
  if (!match) return "1:1";
  const ratio = Number(match[1]) / Number(match[2]);
  return RATIOS.find(([value]) => Math.abs(ratio - value) < 0.05)?.[1] || "1:1";
}

// 统一请求入口：401 / INVALID_TOKEN 时强制刷新登录态并重试一次
async function request(pathname, init = {}, retried = false) {
  const token = await getAccessToken();
  const response = await fetch(`${config.l0veyou.baseUrl}${pathname}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  const payload = await response.json().catch(() => null);

  if ((response.status === 401 || payload?.code === "INVALID_TOKEN") && !retried) {
    log.warn("登录态已失效，刷新后重试");
    invalidateAccessToken();
    await getAccessToken({ force: true });
    return request(pathname, init, true);
  }
  if (!response.ok || payload?.code !== 0) {
    throw badGateway(`l0veyou 请求失败: ${payload?.message || `HTTP ${response.status}`}`);
  }
  return payload;
}
