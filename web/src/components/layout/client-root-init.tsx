import type { ReactNode } from "react";
import { useEffect } from "react";
import { usePromptSourceScheduler } from "@/hooks/use-prompt-source-scheduler";
import { useConfigStore } from "@/stores/use-config-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    usePromptSourceScheduler();

    // 页面初始化时自动从后端 /models 同步可用模型列表，无需手动配置
    useEffect(() => {
        fetch("/api-proxy/v1/models")
            .then((res) => res.json())
            .then((data) => {
                const modelIds = data?.data?.map((m: { id: string }) => m.id);
                if (Array.isArray(modelIds) && modelIds.length) {
                    useConfigStore.setState((state) => {
                        const channel = state.config.channels[0];
                        if (!channel) return state;
                        const channelModels = modelIds.map((name: string) => ({ name, capability: "image" as const }));
                        const encodedModels = channelModels.map((m: { name: string }) => `default::${m.name}`);
                        const currentModel = encodedModels.includes(state.config.imageModel) ? state.config.imageModel : encodedModels[0];
                        return {
                            config: {
                                ...state.config,
                                channels: [{ ...channel, models: channelModels }],
                                models: encodedModels,
                                model: currentModel,
                                imageModel: currentModel,
                            },
                        };
                    });
                }
            })
            .catch(() => {});
    }, []);

    return <>{children}</>;
}
