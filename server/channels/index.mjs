import { config } from "../config.mjs";
import { badRequest } from "../lib/errors.mjs";
import * as l0veyou from "./l0veyou/index.mjs";
import * as upstream from "./upstream.mjs";

// 渠道注册表：新增渠道只需实现统一接口（listModels / generateImage / 可选 forward）并注册，
// 模型列表自动聚合、`渠道/模型` 自动分发，前端无需任何适配。
const registry = new Map();

export function register(channel) {
  if (!channel?.id) throw new Error("渠道必须声明 id");
  registry.set(channel.id, channel);
  return channel;
}

export function getChannel(channelId) {
  return registry.get(channelId) || null;
}

export function channelList() {
  return Array.from(registry.values());
}

function isChannelActive(channel) {
  return channel.enabled ? channel.enabled() : true;
}

// 解析 `渠道/模型`：未带前缀时回退到默认渠道，保持与旧配置兼容
export function resolveModel(value) {
  const raw = String(value || "").trim() || config.defaultModel;
  const at = raw.indexOf("/");
  if (at > 0) {
    const channelId = raw.slice(0, at);
    const model = raw.slice(at + 1);
    if (registry.has(channelId) && model) return { channelId, model };
  }
  return { channelId: config.upstream.id, model: raw };
}

// 聚合各渠道模型：失败时使用该渠道的兜底列表，保证列表接口永不空返
export async function collectModels(provider) {
  const results = await Promise.all(
    channelList().filter(isChannelActive).map(async (channel) => {
      try {
        return { channel, models: await provider(channel) };
      } catch (error) {
        return { channel, models: channel.fallbackModels?.() || [], error };
      }
    }),
  );

  const models = [];
  for (const { channel, models: list } of results) {
    for (const item of list) {
      // 统一模型 ID 为 `渠道/模型`，附带能力标签供前端模型选择器分组
      models.push({ id: `${channel.id}/${item.id}`, object: "model", capability: item.capability || "image" });
    }
  }
  return models;
}

export function requireImageChannel(model) {
  const { channelId, model: plainModel } = resolveModel(model);
  const channel = getChannel(channelId);
  if (!channel) throw badRequest(`未知渠道: ${channelId}`, "UNKNOWN_CHANNEL");
  if (!isChannelActive(channel)) throw badRequest(`渠道未启用: ${channelId}`, "CHANNEL_DISABLED");
  if (typeof channel.generateImage !== "function") throw badRequest(`渠道不支持生图: ${channelId}`, "CHANNEL_NO_IMAGE");
  return { channel, model: plainModel };
}

register(upstream);
register(l0veyou);
