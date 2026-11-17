/**
 * 付费端到端验收（docs/fit/P2-ACCEPTANCE.md）的期望请求清单生成器：用画布真实的提交路径（createFitVideoTask、requestFitImages，
 * 也就是 canvasToFitValues → validateSubmission → 托管 → 同步来的 buildRelayRequest）算出每张代表卡会发出的请求。
 * 全局 fetch 和 /api/fit/catalog 都打桩，不向 openai.fit 发任何生成或上传请求；没给 --pricing/--caps 时只读 GET 公开的
 * /api/pricing、/api/model-capabilities。付费验收前重跑一次：fit 的卡片契约一天可能改好几次。
 *
 *   bun scripts/fit-acceptance.ts [--pricing p.json --caps c.json] [--image a.jpg --image b.jpg --image c.jpg]
 *       [--video v.mp4 --video-seconds 5] [--audio a.mp3 --audio-seconds 8] [--video-prompt p.txt] [--image-prompt p.txt] [--out 文件.md]
 *
 * 不给素材时用同名的假字节，请求结构不变，只是没按真文件大小判断要不要托管、提示词长度也没按真提示词核对。
 * 用例、素材参数、目录和打桩导出给付费验收执行器 fit-e2e.ts 复用。
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import axios from "axios";
import { clearHostedUploadCache } from "@/lib/fit-generate/lib/upload-client";
import { FIT_ORIGIN } from "@/lib/model-channel";
import { createFitVideoTask } from "@/services/api/fit/video";
import { requestFitImages } from "@/services/api/fit/image";
import type { FitVideoConfig } from "@/services/api/fit/video";
import type { AiConfig } from "@/stores/use-config-store";

export type Refs = { images?: number; firstFrame?: boolean; lastFrame?: boolean; videos?: number; audios?: number };
export type Case = { id: string; model: string; title: string; prompt?: "video"; settings: Partial<Record<"videoSeconds" | "vquality" | "size" | "quality", string>> & { count?: number }; refs: Refs };
export type Material = { name: string; mime: string; base64: string; seconds?: number };
export type Call = { method: string; url: string; init?: RequestInit };

/** 代表卡：今天在售的视频卡只有 url-lists、content、media、numbered 四种参考写法，每种至少一张；图片覆盖 JSON 文生图、JSON 改图、multipart 改图和 Gemini。 */
export const CASES: Case[] = [
    { id: "V1", model: "seedance-2.0-mini-super", title: "url-lists：3 张参考图 + 1 段参考音频（托管）", settings: { size: "9:16" }, refs: { images: 3, audios: 1 } },
    { id: "V2", model: "wan3.0-video-1080-GT", title: "url-lists：参考图 + 参考视频 + 参考音频（托管）", settings: { videoSeconds: "5", size: "9:16" }, refs: { images: 3, videos: 1, audios: 1 } },
    { id: "V3", model: "seedance2.0 mini stable", title: "content：参考图 + 参考视频 + 参考音频（托管）", settings: { videoSeconds: "4", vquality: "480p", size: "9:16" }, refs: { images: 3, videos: 1, audios: 1 } },
    { id: "V4", model: "seedance2.0 mini Love", title: "content：首帧（不托管，data URL 内联）", settings: { videoSeconds: "4", vquality: "480p", size: "9:16" }, refs: { firstFrame: true } },
    { id: "V5", model: "wan3.0-video", title: "media：首帧 + 尾帧（托管）", settings: { videoSeconds: "5", vquality: "480P", size: "9:16" }, refs: { firstFrame: true, lastFrame: true } },
    { id: "V6", model: "minimax H3-self", title: "numbered：3 张参考图（托管后填 ref_image_N）", settings: { videoSeconds: "6", vquality: "480p竖" }, refs: { images: 3 } },
    { id: "I1", model: "gpt-image-2", title: "openai-image JSON 文生图（要 2 张 = 并发 2 个单张请求）", settings: { size: "1024x1536", count: 2 }, refs: {} },
    // 卡片说明写着提示词最多 5000 字（fit 的契约按 12000 放行），原角色提示词 8000 多字会被上游拒，这张用视频的原提示词
    { id: "I2", model: "gpt-image-2-1K-4K", title: "openai-image JSON 改图（1 张参考图）", prompt: "video", settings: { size: "9:16" }, refs: { images: 1 } },
    { id: "I3", model: "gpt-image-2-codex-MAX", title: "openai-image multipart 改图（1 张参考图）", settings: { size: "1024x1536" }, refs: { images: 1 } },
    { id: "I4", model: "gemini-nano-banana-2.1", title: "gemini-image：1 张参考图（inline_data）", settings: { size: "9:16", quality: "medium" }, refs: { images: 1 } },
];

export const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4" };
export const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** 打桩时用的假令牌。 */
export const API_KEY = "sk-acceptance-plan";

/** 目录和素材参数，fit-e2e.ts 用同一套。 */
export const MATERIAL_OPTIONS = {
    pricing: { type: "string" },
    caps: { type: "string" },
    image: { type: "string", multiple: true },
    video: { type: "string" },
    "video-seconds": { type: "string", default: "5" },
    audio: { type: "string" },
    "audio-seconds": { type: "string", default: "8" },
    "video-prompt": { type: "string" },
    "image-prompt": { type: "string" },
} as const;
export type MaterialArgs = { pricing?: string; caps?: string; image?: string[]; video?: string; "video-seconds"?: string; audio?: string; "audio-seconds"?: string; "video-prompt"?: string; "image-prompt"?: string };

function material(file: string | undefined, fallback: string, seconds?: string): Material {
    const name = path.basename(file || fallback);
    const base64 = file ? readFileSync(file).toString("base64") : Buffer.from(`fake-bytes:${name}`).toString("base64");
    return { name, mime: MIME[path.extname(name).toLowerCase()] || "application/octet-stream", base64, ...(seconds ? { seconds: Number(seconds) } : {}) };
}

export type Materials = ReturnType<typeof loadMaterials>;

/** 读素材和提示词；没给的用同名假字节和占位短句。 */
export function loadMaterials(args: MaterialArgs) {
    const imageFiles = args.image ?? [];
    const images = ["ref_1_yeyou.jpg", "ref_2_jiangyumeng.jpg", "ref_3_nvshengjia.jpg"].map((name, index) => material(imageFiles[index], name));
    const video = material(args.video, "ref-cartoon-5s-480p.mp4", args["video-seconds"]);
    const audio = material(args.audio, "参考音频-琶音8秒.mp3", args["audio-seconds"]);
    const prompts = {
        video: args["video-prompt"] ? readFileSync(args["video-prompt"], "utf8") : "漫剧分镜：图一是叶悠，图二是江语梦，图三是女生甲。叶悠拖着行李箱走进校门，回头微笑，镜头缓慢推进。",
        image: args["image-prompt"] ? readFileSync(args["image-prompt"], "utf8") : "漫剧角色身份板：依据参考图生成 9:16 竖版三分区角色定妆照。",
    };
    const promptLabel = (kind: "video" | "image") => `<${kind === "video" ? "视频" : "图片"}提示词全文：${path.basename(args[`${kind}-prompt`] || "（未给，用的是占位短句）")}，${prompts[kind].length} 字>`;
    const byBase64 = new Map([...images, video, audio].map((item) => [item.base64, item.name]));
    return { imageFiles, images, video, audio, prompts, promptLabel, byBase64 };
}

async function getJson(file: string | undefined, url: string) {
    if (file) return JSON.parse(readFileSync(file, "utf8"));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`GET ${url} 失败：${response.status}`);
    return response.json();
}

/** 读 openai.fit 的公开目录（给了文件就用文件），整理成画布服务器 /api/fit/catalog 的样子。 */
export async function loadCatalog(args: Pick<MaterialArgs, "pricing" | "caps">) {
    const pricingRaw = await getJson(args.pricing, `${FIT_ORIGIN}/api/pricing`);
    const capsRaw = await getJson(args.caps, `${FIT_ORIGIN}/api/model-capabilities`);
    const pricing = (pricingRaw.data ?? pricingRaw) as Array<{ model_name: string; supported_endpoint_types?: string[] | null; tags?: string; billing_usage_schema?: unknown; description?: string }>;
    /** 模拟一把能调全部公开模型的令牌（/v1/models 列出价目表里的全部模型）。 */
    const tokenModels = pricing.map((entry) => ({ id: entry.model_name, supported_endpoint_types: entry.supported_endpoint_types }));
    const catalog = {
        pricing: pricing.map(({ model_name, supported_endpoint_types, tags, billing_usage_schema }) => ({ model_name, supported_endpoint_types, tags, billing_usage_schema })),
        capabilities: capsRaw.data ?? capsRaw,
        fetchedAt: Date.now(),
        stale: false,
    };
    return { pricing, tokenModels, catalog };
}

/** 画布服务器的 /api/fit/catalog 打桩成读到的目录；其他画布服务器接口一律报错，不发出去。 */
export function stubCanvasCatalog(catalog: unknown) {
    axios.defaults.adapter = async (config) => {
        if (config.url !== "/api/fit/catalog") throw new Error(`没打桩的画布服务器请求：${config.method} ${config.url}`);
        return { data: { code: 0, data: catalog, msg: "" }, status: 200, statusText: "", headers: {}, config };
    };
}

/**
 * openai.fit 打桩：除 GET /v1/models 外每个请求都记进 calls。视频任务一查就完成，成片回 videoBase64 的字节（没给就是假字节）；
 * 出图回 1×1 的 PNG；文本回两段 SSE。
 */
export function stubFitFetch(tokenModels: unknown[], calls: Call[], videoBase64 = ""): typeof fetch {
    let tasks = 0;
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method || "GET";
        if (url === `${FIT_ORIGIN}/v1/models`) return Response.json({ success: true, object: "list", data: tokenModels });
        calls.push({ method, url, init });
        if (url === `${FIT_ORIGIN}/v1/uploads`) {
            const file = (init?.body as FormData).get("file") as File;
            return Response.json({ url: `${FIT_ORIGIN}/uploads/${encodeURIComponent(file.name)}`, expires_at: Math.floor(Date.now() / 1000) + 72 * 3600 });
        }
        if (url === `${FIT_ORIGIN}/v1/videos`) return Response.json({ id: `task_acceptance_${++tasks}`, status: "queued", progress: 0 });
        const task = /^\/v1\/videos\/(task_acceptance_\d+)(\/content)?$/.exec(url.slice(FIT_ORIGIN.length));
        if (task && !task[2]) return Response.json({ id: task[1], status: "completed", progress: 100 });
        if (task) return new Response(Buffer.from(videoBase64 || Buffer.from("fake-bytes:video").toString("base64"), "base64"), { headers: { "Content-Type": "video/mp4" } });
        if (url.includes(":generateContent")) return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: PNG_B64 } }] } }] });
        if (url.startsWith(`${FIT_ORIGIN}/v1/images/`)) return Response.json({ data: [{ b64_json: PNG_B64 }] });
        if (url === `${FIT_ORIGIN}/v1/chat/completions`) {
            const events = ["叶悠拖着行李箱", "走进校门，回头微笑。"].map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
            return new Response([...events, "data: [DONE]\n\n"].join(""), { headers: { "Content-Type": "text/event-stream" } });
        }
        throw new Error(`没打桩的请求：${method} ${url}`);
    }) as typeof fetch;
}

/** 打桩时 /v1/uploads 回的链接对应哪个文件。 */
export function stubUploadName(url: string) {
    return url.startsWith(`${FIT_ORIGIN}/uploads/`) ? decodeURIComponent(url.slice(`${FIT_ORIGIN}/uploads/`.length)) : undefined;
}

/** 请求体里的素材、提示词换成占位说明，方便和浏览器里实际发出的请求逐项对照。uploadName 认出 /v1/uploads 回的链接是哪个文件。 */
export function createRedactor(m: Materials, uploadName: (url: string) => string | undefined) {
    function redact(value: unknown, kind: "video" | "image"): unknown {
        if (Array.isArray(value)) return value.map((item) => redact(item, kind));
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, kind)]));
        if (typeof value !== "string") return value;
        if (value === m.prompts[kind].trim() || value === m.prompts[kind]) return m.promptLabel(kind);
        const uploaded = uploadName(value);
        if (uploaded) return `<上传 ${uploaded} 后 /v1/uploads 返回的链接>`;
        const dataUrl = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value);
        if (dataUrl) return `<${m.byBase64.get(dataUrl[2]) ?? "未知素材"} 的 data URL（${dataUrl[1]}）>`;
        if (m.byBase64.has(value)) return `<${m.byBase64.get(value)} 的裸 base64>`;
        return value;
    }

    async function describeBody(init: RequestInit | undefined, kind: "video" | "image") {
        const body = init?.body;
        if (body instanceof FormData) {
            const fields: Record<string, unknown> = {};
            for (const [key, item] of body.entries()) {
                const shown = typeof item === "string" ? redact(item, kind) : `<文件 ${m.byBase64.get(Buffer.from(await item.arrayBuffer()).toString("base64")) ?? item.name}（${item.type}）>`;
                fields[key] = key in fields ? [fields[key], shown].flat() : shown;
            }
            return { format: "multipart/form-data", fields };
        }
        return { format: "application/json", body: redact(JSON.parse(String(body)), kind) };
    }

    return { redact, describeBody };
}

export function headerNote(init: RequestInit | undefined, apiKey: string) {
    const headers = new Headers(init?.headers);
    return `Authorization: ${headers.get("Authorization")?.replace(apiKey, "<令牌>") || "（没带）"}；credentials: ${init?.credentials ?? "（没写）"}`;
}

/** 画布节点给生成接口的素材（参考图、首尾帧、参考视频、参考音频）。 */
export function canvasInput(m: Materials, refs: Refs) {
    const image = (item: Material, index: number) => ({ id: `img-${index}`, name: item.name, type: item.mime, dataUrl: `data:${item.mime};base64,${item.base64}` });
    const media = (item: Material, id: string) => ({ id, name: item.name, type: item.mime, url: `data:${item.mime};base64,${item.base64}`, durationMs: (item.seconds ?? 0) * 1000 });
    return {
        references: m.images.slice(0, refs.images ?? 0).map(image),
        firstFrame: refs.firstFrame ? image(m.images[0], 90) : null,
        lastFrame: refs.lastFrame ? image(m.images[1], 91) : null,
        videoReferences: Array.from({ length: refs.videos ?? 0 }, () => media(m.video, "video-1")),
        audioReferences: Array.from({ length: refs.audios ?? 0 }, () => media(m.audio, "audio-1")),
    };
}

export function refsText(m: Materials, refs: Refs) {
    const parts = [
        refs.firstFrame && `首帧 ${m.images[0].name}`,
        refs.lastFrame && `尾帧 ${m.images[1].name}`,
        refs.images &&
            `参考图 ${m.images
                .slice(0, refs.images)
                .map((item) => item.name)
                .join("、")}`,
        refs.videos && `参考视频 ${m.video.name}（${m.video.seconds} 秒）`,
        refs.audios && `参考音频 ${m.audio.name}（${m.audio.seconds} 秒）`,
    ].filter(Boolean);
    return parts.length ? parts.join("；") : "无";
}

async function main() {
    const { values: args } = parseArgs({ options: { ...MATERIAL_OPTIONS, out: { type: "string" } } });
    const m = loadMaterials(args);
    const { pricing, tokenModels, catalog } = await loadCatalog(args);
    const calls: Call[] = [];
    globalThis.fetch = stubFitFetch(tokenModels, calls);
    stubCanvasCatalog(catalog);
    const { describeBody } = createRedactor(m, stubUploadName);

    const lines: string[] = [
        "# 付费验收：期望请求（脚本生成，勿手改）",
        "",
        `由 \`web/scripts/fit-acceptance.ts\` 生成：fit 生成库副本 ${JSON.parse(readFileSync(new URL("../src/lib/fit-generate/SOURCE.json", import.meta.url), "utf8")).commit.slice(0, 7)}，目录${args.pricing ? `取自 ${path.basename(args.pricing)}` : "为生成时只读 GET 的 openai.fit /api/pricing"}（${pricing.length} 款）。`,
        `素材：${[...m.images, m.video, m.audio].map((item) => item.name).join("、")}${m.imageFiles.length ? "（真文件）" : "（没给真文件，用的是同名假字节）"}。`,
        "占位说明：<…的 data URL>、<…的裸 base64> 是该素材的内容（浏览器里超过 1280 边长或 2MB 的图会先缩小成 JPEG，要补边的卡会补成所选画幅并改名 .jpg）；<上传 … 后 /v1/uploads 返回的链接> 是托管后的 https 链接（同一内容 72 小时内复用，第二次起不再上传）。",
        "",
    ];

    for (const item of CASES) {
        // 每张卡都按「这批素材第一次用」算，列出它要托管哪些文件（浏览器里同一内容 72 小时内复用，第二次起不再上传）
        clearHostedUploadCache();
        calls.length = 0;
        const kind = item.id.startsWith("V") ? "video" : "image";
        const promptKind = item.prompt ?? kind;
        const input = canvasInput(m, item.refs);
        const settings = Object.entries(item.settings)
            .map(([key, value]) => `${key}=${value}`)
            .join("，");
        let outcome = "校验通过";
        try {
            if (kind === "video") {
                const config: FitVideoConfig = { apiKey: API_KEY, model: item.model, videoModel: item.model, ...item.settings };
                await createFitVideoTask(config, m.prompts.video, input);
            } else {
                const config = { apiKey: API_KEY, model: item.model, ...item.settings, count: String(item.settings.count ?? 1) } as unknown as AiConfig;
                await requestFitImages(config, m.prompts[promptKind], input.references, item.settings.count ?? 1);
            }
        } catch (error) {
            outcome = `校验不通过（不会发请求）：${error instanceof Error ? error.message : String(error)}`;
        }
        const uploads = calls.filter((call) => call.url === `${FIT_ORIGIN}/v1/uploads`);
        const sends = calls.filter((call) => call.url !== `${FIT_ORIGIN}/v1/uploads`);
        lines.push(`## ${item.id} ${item.model}`, "", `- 验什么：${item.title}`, `- 画布设置：${settings}`, `- 参考素材：${refsText(m, item.refs)}`, `- 提示词：${m.promptLabel(promptKind)}`, `- 预检：${outcome}`);
        // 上传两路并发，先后不固定，按文件名排序输出
        if (uploads.length)
            lines.push(
                `- 先上传：${uploads
                    .map((call) => ((call.init?.body as FormData).get("file") as File).name)
                    .sort()
                    .join("、")}，各一次 POST ${FIT_ORIGIN}/v1/uploads（${headerNote(uploads[0].init, API_KEY)}）`,
            );
        if (sends.length) {
            lines.push(
                `- 生成请求：${sends.length} 次 ${sends[0].method} ${sends[0].url}（${headerNote(sends[0].init, API_KEY)}）${sends.length > 1 ? "，请求体都相同" : ""}`,
                "",
                "```json",
                JSON.stringify(await describeBody(sends[0].init, promptKind), null, 2),
                "```",
            );
        }
        lines.push("");
    }

    const text = lines.join("\n");
    if (args.out) writeFileSync(args.out, text);
    else console.log(text);
}

// 被 fit-e2e.ts 导入时不跑
if ((import.meta as ImportMeta & { main?: boolean }).main) await main();
