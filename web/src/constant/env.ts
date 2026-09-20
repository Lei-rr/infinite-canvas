export const APP_VERSION = __APP_VERSION__ || "dev";

export const DOCS_URL = import.meta.env.VITE_DOC_URL || "https://docs.canvas.best";

// Official plugin registry URL: CI publishes to plugins-dist for jsDelivr delivery; an environment variable may override it for self-hosting.
export const PLUGIN_REGISTRY_URL = import.meta.env.VITE_PLUGIN_REGISTRY_URL || "https://cdn.jsdelivr.net/gh/basketikun/infinite-canvas@plugins-dist/official-plugins.json";

// [定制] 站点标题由容器启动时注入的运行时配置提供，未注入时回退到 i18n 标题。
export function runtimeAppTitle(): string {
    return (window as unknown as { __RUNTIME_CONFIG__?: { APP_TITLE?: string } })?.__RUNTIME_CONFIG__?.APP_TITLE?.trim() || "";
}
