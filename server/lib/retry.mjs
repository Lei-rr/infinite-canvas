import { config } from "../config.mjs";
import { createLogger } from "./logger.mjs";

const log = createLogger("retry");

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 固定并发上限的任务队列：超出上限的请求排队，避免上游被打满
export class TaskQueue {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiting = [];
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.active += 1;
        resolve(() => this.release());
      });
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }
}

// 带指数抖动退避的重试；shouldRetry 返回 false 时立即抛出，避免无效重试
export async function withRetry(task, { name = "task", retries = config.retries, delayMs = config.retryDelayMs, shouldRetry = () => true } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) break;
      const jitter = Math.floor(Math.random() * 600);
      const waitMs = delayMs * attempt + jitter;
      log.warn(`${name} 第 ${attempt}/${retries} 次失败，${waitMs}ms 后重试: ${error.message}`);
      await sleep(waitMs);
    }
  }
  throw lastError;
}
