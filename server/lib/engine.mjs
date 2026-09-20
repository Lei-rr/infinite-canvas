import { config } from "../config.mjs";
import { requireImageChannel } from "../channels/index.mjs";
import { badRequest } from "./errors.mjs";
import { TaskQueue, sleep, withRetry } from "./retry.mjs";

const queue = new TaskQueue(config.maxConcurrent);

// 所有渠道共用的生图执行器：并发排队 + 重试 + 统一返回格式
export function generateImage(task) {
  const { channel, model } = requireImageChannel(task.model);
  return withRetry(
    async () => {
      const release = await queue.acquire();
      try {
        return await channel.generateImage({ model, prompt: task.prompt, size: task.size, refImages: task.refImages || [] });
      } finally {
        release();
      }
    },
    {
      name: `生图 ${channel.id}/${model}`,
      // 鉴权类错误由渠道内部自愈，业务性错误重试无意义
      shouldRetry: (error) => !["AUTH_MISSING", "INVALID_REQUEST", "CHANNEL_DISABLED"].includes(error?.code),
    },
  );
}

// 批量生图：任务间错峰提交，避免上游限流
export async function generateImageBatch({ count, ...task }) {
  const total = Math.min(Math.max(1, Math.floor(Number(count) || 1)), config.maxBatch);
  const tasks = [];
  for (let index = 0; index < total; index += 1) {
    if (index > 0) await sleep(config.staggerMs);
    tasks.push(generateImage(task));
  }
  return Promise.all(tasks);
}

export function assertPrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) throw badRequest("缺少 prompt 参数", "MISSING_PROMPT");
  return prompt.trim();
}
