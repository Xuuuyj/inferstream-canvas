import type { HomeBanner } from "@/app/(user)/home-banner-carousel";
import { DIRECTOR_ENABLED } from "@/constant/features";
const INFERSTREAM_URL = "https://www.inferstream.cn";
const MODELS_URL = `${INFERSTREAM_URL}/models`;

export const ANNOUNCEMENTS = [
    { text: "浏览 InferStream 支持的模型", linkText: "查看模型", url: MODELS_URL },
];

export const HOME_BANNERS: HomeBanner[] = [
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/agent.webp", videoUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/agent.webm", alt: "Agent：读懂画布节点，规划并生成图片和视频" },
    { imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/panorama.webp", alt: "全景图：用文字或参考图生成 2:1 全景场景" },
    ...(DIRECTOR_ENABLED ? [{ imageUrl: "https://gcore.jsdelivr.net/gh/tigerowo/cdn-tdeh@v0.4/img/infinite-canvas/3ddirector.webp", alt: "3D 导演台：布置角色、场景和机位，截图回到画布" }] : []),
];

export const HOME_CTA = { label: "InferStream 模型库", url: MODELS_URL };

export const FOOTER_LINKS = [{ label: "InferStream", url: INFERSTREAM_URL }];

// AGPL 署名与源码入口，不是推广链接。
export const SOURCE_URL = process.env.NEXT_PUBLIC_SOURCE_URL || "/source/";
export const SOURCE_COMMIT = process.env.NEXT_PUBLIC_SOURCE_COMMIT || "";
export const LICENSE_URL = "https://www.gnu.org/licenses/agpl-3.0.html";
export const UPSTREAM_PROJECT = { label: "tigerowo/infinite-canvas", url: "https://github.com/tigerowo/infinite-canvas" };
export const PRIOR_PROJECTS = [
    { label: "basketikun", url: "https://github.com/basketikun/infinite-canvas" },
    { label: "HuFakai", url: "https://github.com/HuFakai/infinite-canvas" },
];
