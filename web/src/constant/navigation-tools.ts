import { FileText, ImagePlus, Images, Maximize2, Settings2, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "image",
        icon: ImagePlus,
    },
    // [定制] 视频创作台入口已停用
    // {
    //     slug: "video",
    //     icon: Video,
    // },
    {
        slug: "prompts",
        icon: FileText,
    },
    {
        slug: "assets",
        icon: Images,
    },
    // [定制] API 设置入口已停用：渠道与凭证由内置 BFF 固定管理，模型自动同步。
    // {
    //     slug: "config",
    //     icon: Settings2,
    // },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];
