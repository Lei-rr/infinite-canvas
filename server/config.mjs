import path from "node:path";

const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const text = (value, fallback = "") => String(value ?? "").trim() || fallback;

const DATA_DIR = path.resolve(text(process.env.DATA_DIR, "/app/data"));

export const config = {
  port: num(process.env.BFF_PORT, 8000),
  dataDir: DATA_DIR,
  mediaDir: path.resolve(text(process.env.IMAGE_DIR, path.join(DATA_DIR, "images"))),
  authDir: path.resolve(text(process.env.AUTH_DIR, path.join(DATA_DIR, "auth"))),

  retries: num(process.env.MAX_RETRIES, 3),
  retryDelayMs: num(process.env.RETRY_DELAY_MS, 1500),
  maxConcurrent: num(process.env.MAX_CONCURRENT, 10),
  staggerMs: num(process.env.STAGGER_INTERVAL_MS, 1000),
  requestTimeoutMs: num(process.env.REQUEST_TIMEOUT_MS, 90_000),
  forwardTimeoutMs: num(process.env.FORWARD_TIMEOUT_MS, 600_000),
  mediaTimeoutMs: num(process.env.IMAGE_DOWNLOAD_TIMEOUT_MS, 45_000),
  maxBatch: num(process.env.MAX_BATCH, 10),
  modelCacheMs: num(process.env.MODEL_CACHE_MS, 300_000),

  upstream: {
    id: "upstream",
    baseUrl: text(process.env.UPSTREAM_URL, "http://localhost:3000").replace(/\/+$/, ""),
    apiKey: text(process.env.UPSTREAM_KEY),
    fallbackModels: text(process.env.MODELS, "gemini-3.1-flash-image,gemini-3.1-flash-image-2K,gemini-3.1-flash-image-4K,gpt-image-2")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  },

  l0veyou: {
    id: "l0veyou",
    baseUrl: text(process.env.L0VEYOU_BASE_URL, "https://l0veyou.com").replace(/\/+$/, ""),
    accessToken: text(process.env.L0VEYOU_ACCESS_TOKEN),
    refreshToken: text(process.env.L0VEYOU_REFRESH_TOKEN),
    pollIntervalMs: num(process.env.L0VEYOU_POLL_INTERVAL_MS, 3000),
    taskTimeoutMs: num(process.env.L0VEYOU_TASK_TIMEOUT_MS, 300_000),
    models: text(process.env.L0VEYOU_MODELS, "gpt-image-2,gpt-image-2-5-flare,gpt-image-2-5-full")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  },

  defaultModel: text(process.env.IMAGE_MODEL),
};
