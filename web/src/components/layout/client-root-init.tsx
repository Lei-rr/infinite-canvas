import type { ReactNode } from "react";
import { useEffect } from "react";

import { useConfigStore, BUILTIN_CHANNEL_ID } from "@/stores/use-config-store";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";

// [定制] 上游原版通过 URL 参数（baseUrl/apiKey）导入渠道凭证；本项目改为启动时从内置 BFF 拉取渠道模型。
// 原实现保留在下方注释中，便于后续与上游版本对照。
//
// import { useRef } from "react";
// import { App } from "antd";
// import { useTranslation } from "react-i18next";
// const { message } = App.useApp();
// const { t } = useTranslation();
// const handledConfigParams = useRef(false);
// const importChannelCredentials = useConfigStore((state) => state.importChannelCredentials);
// const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
// useEffect(() => {
//     if (handledConfigParams.current) return;
//     const searchParams = new URLSearchParams(window.location.search);
//     const baseUrl = searchParams.get("baseUrl") || searchParams.get("baseurl");
//     const apiKey = searchParams.get("apiKey") || searchParams.get("apikey");
//     if (!baseUrl && !apiKey) return;
//     handledConfigParams.current = true;
//     searchParams.delete("baseUrl");
//     searchParams.delete("baseurl");
//     searchParams.delete("apiKey");
//     searchParams.delete("apikey");
//     window.history.replaceState(null, "", `${window.location.pathname}${searchParams.size ? `?${searchParams}` : ""}${window.location.hash}`);
//     const result = importChannelCredentials({ baseUrl, apiKey });
//     openConfigDialog(false, "channels");
//     if (result.status === "created") message.success(t("config.importedChannelCreated", { name: result.channelName }));
//     else if (result.status === "updated") message.success(t("config.importedChannelUpdated", { name: result.channelName }));
//     else if (result.status === "missing-base-url") message.error(t("config.importedChannelBaseUrlRequired"));
//     else message.error(t("config.importedChannelBaseUrlInvalid"));
// }, [importChannelCredentials, message, openConfigDialog, t]);

type RemoteModel = { id?: string; capability?: string };
type ModelsPayload = { data?: RemoteModel[] };
type Capability = "image" | "video" | "text" | "audio";

export function ClientRootInit({ children }: { children: ReactNode }) {
    usePromptSourceScheduler();

    // [定制] 启动时从内置 BFF 同步渠道模型列表，新增渠道无需改动前端。
    useEffect(() => {
        Promise.resolve()
            .then(() => fetch("/api-proxy/v1/models"))
            .then((response) => (response.ok ? (response.json() as Promise<ModelsPayload>) : null))
            .then((payload) => {
                const models = (payload?.data || [])
                    .map((item) => ({ id: (item.id || "").trim(), capability: normalizeCapability(item.capability) }))
                    .filter((item) => item.id);
                if (!models.length) return;
                useConfigStore.setState((state) => {
                    const channel = state.config.channels.find((item) => item.id === BUILTIN_CHANNEL_ID) || state.config.channels[0];
                    if (!channel) return state;
                    const channelModels = models.map((item) => ({ name: item.id, capability: item.capability }));
                    const encodedModels = channelModels.map((item) => `${channel.id}::${item.name}`);
                    // 保留已选模型；失效时按能力回退到同类第一个模型，保证各工作台开箱即用
                    const pick = (value: string, capability: Capability) => {
                        if (encodedModels.includes(value)) return value;
                        const fallback = models.find((item) => item.capability === capability);
                        return fallback ? `${channel.id}::${fallback.id}` : "";
                    };
                    const model = pick(state.config.model, "image") || pick(state.config.imageModel, "image");
                    return {
                        config: {
                            ...state.config,
                            channels: [{ ...channel, models: channelModels }],
                            models: encodedModels,
                            model,
                            imageModel: pick(state.config.imageModel, "image") || model,
                            videoModel: pick(state.config.videoModel, "video"),
                            textModel: pick(state.config.textModel, "text"),
                            audioModel: pick(state.config.audioModel, "audio"),
                        },
                    };
                });
            })
            .catch(() => {});
    }, []);

    return <>{children}</>;
}

// [定制] 后端返回的模型能力标签直接采用，缺失时按名称推测（与上游 guessCapability 保持一致）。
function normalizeCapability(value: string | undefined): "image" | "video" | "audio" | "text" {
    if (value === "image" || value === "video" || value === "audio" || value === "text") return value;
    return "image";
}
