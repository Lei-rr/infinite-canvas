# 服务端（内置 BFF）

前端默认渠道固定指向本站内置 BFF（`/api-proxy`），由 BFF 聚合各上游渠道并统一输出格式，
前端不感知具体渠道，新增渠道无需改动前端。

## 目录结构

```
server/
├── index.mjs                 进程入口：装配 HTTP 服务、优雅退出
├── config.mjs                环境变量集中读取与默认值
├── lib/
│   ├── errors.mjs            HttpError 与常用错误构造
│   ├── logger.mjs            分级日志
│   ├── http.mjs              JSON 收发、请求体读取
│   ├── retry.mjs             并发队列与指数退避重试
│   ├── media-store.mjs       媒体落盘、读取、回源兜底
│   ├── image-result.mjs      各渠道图片结果统一提取
│   └── engine.mjs            生图调度：渠道解析、排队、重试、批量
├── channels/
│   ├── index.mjs             渠道注册表与模型聚合适配
│   ├── upstream.mjs          上游 OpenAI 兼容网关
│   └── l0veyou/
│       ├── index.mjs         l0veyou 异步任务生图
│       └── token.mjs         登录态刷新与持久化
└── routes/
    ├── index.mjs             路由分发：模型、健康检查、媒体、生图、透传
    ├── images.mjs            生图与图生图
    └── forward.mjs           其他 /v1 请求透传
```

## 请求流程

```
浏览器 → Nginx :3000 → /api-proxy/* → BFF :8000
  GET  /v1/models            聚合各渠道模型，返回 { id: `渠道/模型`, capability }
  POST /v1/images/generations 解析 `渠道/模型` → 渠道生图 → 本地持久化 → { data: [{ url }] }
  POST /v1/images/edits       参考图转 dataURL → 同上
  其他 /v1/*                  透传上游（转发前去除模型名中的渠道前缀，支持 SSE 流式）
  GET  /images/*              本地媒体直出，未命中回源上游
```

## 新增渠道

在 `channels/` 下新建模块并导出：

```js
export const id = "example";
export const label = "示例渠道";
export function enabled() { return true; }                    // 可选，默认启用
export async function listModels() { ... }                    // 返回 [{ id, capability }]
export async function generateImage({ model, prompt, size, refImages }) { ... } // 返回站内图片路径
```

然后在 `channels/index.mjs` 中 `register(channel)`，模型列表与 `渠道/模型` 分发自动生效。

## 环境变量

见仓库根目录 `.env.example`。
