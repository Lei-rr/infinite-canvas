import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../../config.mjs";
import { unauthorized } from "../../lib/errors.mjs";
import { createLogger } from "../../lib/logger.mjs";

const log = createLogger("channel:l0veyou:token");

const TOKEN_FILE = path.join(config.authDir, "l0veyou.json");

// 登录态安全窗口：距过期不足 5 分钟即提前刷新，避免请求途中失效
const EXPIRY_WINDOW_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 15_000;

const state = {
  loaded: false,
  accessToken: config.l0veyou.accessToken,
  refreshToken: config.l0veyou.refreshToken,
  expiresAt: decodeExpiry(config.l0veyou.accessToken),
};
let refreshing = null;

function decodeExpiry(token) {
  if (!token) return 0;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return Number(payload.exp) * 1000 || 0;
  } catch {
    return 0;
  }
}

async function loadPersisted() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const saved = JSON.parse(await fs.readFile(TOKEN_FILE, "utf8"));
    if (saved?.accessToken) state.accessToken = saved.accessToken;
    if (saved?.refreshToken) state.refreshToken = saved.refreshToken;
    if (saved?.expiresAt) state.expiresAt = Number(saved.expiresAt);
    log.info("已载入本地登录态");
  } catch {}
}

async function persist() {
  try {
    await fs.writeFile(
      TOKEN_FILE,
      JSON.stringify({ accessToken: state.accessToken, refreshToken: state.refreshToken, expiresAt: state.expiresAt, updatedAt: Date.now() }, null, 2),
      { mode: 0o600 },
    );
  } catch (error) {
    log.warn(`登录态落盘失败: ${error.message}`);
  }
}

async function refreshAccessToken() {
  if (!state.refreshToken) throw unauthorized("l0veyou 登录态缺失，请配置 L0VEYOU_REFRESH_TOKEN", "AUTH_MISSING");
  const response = await fetch(`${config.l0veyou.baseUrl}/api/v1/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: state.refreshToken }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => null);
  const data = payload?.data;
  if (!response.ok || payload?.code !== 0 || !data?.access_token) {
    throw unauthorized(`l0veyou 登录态刷新失败: ${payload?.message || `HTTP ${response.status}`}`, "AUTH_REFRESH_FAILED");
  }
  state.accessToken = data.access_token;
  // refresh token 每次刷新都会轮换，必须持久化，否则重启后旧值失效
  state.refreshToken = data.refresh_token || state.refreshToken;
  state.expiresAt = Date.now() + Number(data.expires_in || 86_400) * 1000;
  await persist();
  log.info("登录态已刷新");
  return state.accessToken;
}

export async function getAccessToken({ force = false } = {}) {
  await loadPersisted();
  const fresh = state.accessToken && state.expiresAt - Date.now() > EXPIRY_WINDOW_MS;
  if (!force && fresh) return state.accessToken;
  if (!refreshing) {
    refreshing = refreshAccessToken().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export function invalidateAccessToken() {
  state.expiresAt = 0;
}
