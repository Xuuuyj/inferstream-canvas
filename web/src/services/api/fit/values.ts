import { downscaleImage } from "@/lib/fit-generate/lib/image-downscale";
import { aspectRatiosAt, customerAdvancedValues, defaultFormValuesFor, secondsRuleAt } from "@/lib/fit-generate/lib/model-profiles";
import { mentionOptions } from "@/lib/fit-generate/lib/prompt-mentions";
import type { SubmissionIssue } from "@/lib/fit-generate/lib/validate-submission";
import messages from "@/lib/fit-generate/messages.zh.json";
import type { AdvancedParam, AdvancedValues, GenerationFormValues, ModelProfile, ReferenceAssetKind, ReferenceImage as FitReference, ReferenceRole, SecondsRule } from "@/lib/fit-generate/types";
import { dataUrlToFile, readFileAsDataUrl } from "@/lib/image-utils";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

/** 换算要读的画布设置；fitAdvanced 是 fit 卡片高级参数的取值（P2-A5 加进 AiConfig），fitMentionLabels 见 withFitMentions。 */
export type FitValuesConfig = Partial<Pick<AiConfig, "videoSeconds" | "vquality" | "size" | "quality" | "systemPrompt" | "systemPrompts">> & { fitAdvanced?: AdvancedValues; fitMentionLabels?: Record<string, string> };
/** 画布节点的参考素材，和 video.ts 的 VideoReferenceInput 同形；出图只传 references。 */
export type FitReferenceInput = { references?: ReferenceImage[]; firstFrame?: ReferenceImage | null; lastFrame?: ReferenceImage | null; videoReferences?: ReferenceVideo[]; audioReferences?: ReferenceAudio[] };

type CanvasMedia = ReferenceImage | ReferenceVideo | ReferenceAudio;
type MediaKind = Exclude<ReferenceAssetKind, "image">;
export type Slot = readonly [ReferenceAssetKind, ReferenceRole, CanvasMedia];
/** 给一个素材补上内容：base 是还没读内容的 fit 素材（id、名字、种类、用途）。生成前预检换成不读文件的版本。 */
export type FitMediaReader = (base: FitReference, source: CanvasMedia) => Promise<FitReference>;

const zh = messages as Record<string, string>;
const ROLE_LABELS: Record<string, string> = { first_frame: "首帧", last_frame: "尾帧", reference: "参考素材" };
const CANVAS_KIND_LABELS: Record<ReferenceAssetKind, string> = { image: "图片", video: "视频", audio: "音频" };
const GEMINI_TIERS: Record<string, string> = { low: "1k", medium: "2k", high: "4k" };

/**
 * 把画布给素材的标签（素材 id → 图片N / 视频N / 音频N，就是提示词里 @ 出来的那些）挂到配置上。
 * 生成接口只把配置原样传到 canvasToFitValues（素材会被重新整理），所以标签跟着配置走。
 */
export function withFitMentions<T extends object>(config: T, labels: Record<string, string> | undefined): T & Pick<FitValuesConfig, "fitMentionLabels"> {
    return { ...config, fitMentionLabels: labels };
}

function ratioOf(value: string) {
    const match = /^(\d+(?:\.\d+)?)\s*[x:×]\s*(\d+(?:\.\d+)?)$/i.exec(value.trim());
    return match && Number(match[1]) > 0 && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : null;
}

/** 比例相差 2% 以内算同一画幅（WxH 等于先约分；fit 也把 1024x1360 标成 3:4、1024x1792 标成 9:16）。 */
function sameRatio(option: string, target: number) {
    const ratio = ratioOf(option);
    return ratio != null && Math.abs(Math.log(ratio / target)) < 0.02;
}

/** 画布的 size（16:9、1280x720、auto）对上卡片的画幅；auto 对应 adaptive。 */
function pickAspectRatio(options: string[], size = "") {
    const value = size.trim().toLowerCase();
    if (value === "auto" || value === "adaptive") return options.find((option) => option.toLowerCase() === "adaptive") ?? null;
    const target = ratioOf(value);
    return (target && options.find((option) => sameRatio(option, target))) || null;
}

/** 画布的 vquality（720、720p、2k）不分大小写、不管有没有 p，对上卡片的写法。 */
function pickResolution(options: string[], vquality = "") {
    const key = (value: string) => value.trim().toLowerCase().replace(/p$/, "");
    return options.find((option) => key(option) === key(vquality)) ?? null;
}

/**
 * 时长：有范围的夹到范围里，有档位的吸附到最近一档；画布的 -1（自动）、空值改成卡片默认值；固定时长和没有时长的卡不填。
 */
function pickSeconds(rule: SecondsRule | null, videoSeconds = "") {
    if (rule?.mode !== "range") return null;
    const value = Math.round(Number(videoSeconds));
    if (!(value > 0)) return rule.defaultValue;
    const clamped = Math.min(rule.max, Math.max(rule.min, value));
    return rule.steps?.length ? rule.steps.reduce((best, step) => (Math.abs(step - clamped) < Math.abs(best - clamped) ? step : best)) : clamped;
}

/**
 * 图片尺寸：OpenAI 卡先找完全相同的尺寸，再找同画幅的（画布给了 WxH 取像素数最接近的，只给比例取卡片里排第一的）；
 * Gemini 卡的 quality 存的是卡片原值（0.5K、1K、2K、4K，参数面板直接写），其他图片卡留下的低/中/高按 1K/2K/4K 换算。
 * 对不上返回 null，由调用方取卡片默认值。
 */
function pickImageSize(profile: ModelProfile, config: FitValuesConfig) {
    if (profile.kind !== "image") return null;
    if (profile.imageApi === "gemini-image") {
        const quality = (config.quality || "").toLowerCase();
        return profile.imageSizes.find((size) => size.toLowerCase() === quality || size.toLowerCase() === GEMINI_TIERS[quality]) ?? null;
    }
    const value = (config.size || "").trim().toLowerCase();
    const exact = profile.imageSizes.find((size) => size.toLowerCase() === value);
    if (exact) return exact;
    const target = ratioOf(value);
    const candidates = target ? profile.imageSizes.filter((size) => sameRatio(size, target)) : [];
    const pixels = /^(\d+)x(\d+)$/.exec(value);
    if (!pixels || candidates.length < 2) return candidates[0] ?? null;
    const area = (size: string) => size.split("x").reduce((product, side) => product * Number(side), 1);
    const wanted = Number(pixels[1]) * Number(pixels[2]);
    return candidates.reduce((best, size) => (Math.abs(area(size) - wanted) < Math.abs(area(best) - wanted) ? size : best));
}

function validAdvanced(param: AdvancedParam, value: unknown) {
    if (param.kind === "boolean") return typeof value === "boolean";
    if (param.kind === "integer") return typeof value === "number" && Number.isFinite(value);
    if (param.kind === "text") return typeof value === "string";
    return param.options.some((option) => option.value === value);
}

/**
 * 高级参数只写卡片有的、类型对得上的。和 fit 生成台一样只收客户可选的几项（CUSTOMER_ADVANCED_KEYS：画质、AI 润色、人脸处理），
 * 其余（声音、水印、种子等）由 fit 构造器照卡片默认值发，画布的同名开关不改请求。画布的图片质量（不含 auto）对应卡片的 quality；
 * fitAdvanced 里的值优先。
 */
function pickAdvanced(profile: ModelProfile, config: FitValuesConfig): AdvancedValues {
    const quality: AdvancedValues = config.quality && config.quality !== "auto" ? { quality: config.quality } : {};
    const values = customerAdvancedValues({ ...quality, ...config.fitAdvanced });
    return Object.fromEntries(profile.advanced.filter((param) => validAdvanced(param, values[param.key])).map((param) => [param.key, values[param.key]]));
}

/**
 * 提示词里画布的 @图片N / @视频N / @音频N 按素材改写成 fit 给同一个素材的写法（mentionOptions：首帧 @首帧、尾帧 @尾帧，
 * 参考图、视频、音频按种类重新编号）。画布按连线顺序给全部素材编号，首尾帧也算，fit 只数普通参考素材，所以不能按数字换。
 * 没给标签时参考图、视频、音频各自按传进来的顺序编号（视频、图片工作台的编法，首尾帧不编号）。对不上素材的引用直接报错，不让它指着别的素材发出去。
 */
export function fitMentions(prompt: string, slots: Slot[], references: FitReference[], labels?: Record<string, string>) {
    const tokens = mentionOptions(references);
    const counts: Record<ReferenceAssetKind, number> = { image: 0, video: 0, audio: 0 };
    const byLabel = new Map<string, string>();
    slots.forEach(([kind, role, source], index) => {
        const label = labels ? labels[source.id] : role === "reference" ? `${CANVAS_KIND_LABELS[kind]}${++counts[kind]}` : undefined;
        if (label && !byLabel.has(label)) byLabel.set(label, tokens[index].token);
    });
    const missing = new Set<string>();
    const text = prompt.replace(/@(图片|视频|音频)(\d+)/g, (match: string, kind: string, index: string) => byLabel.get(`${kind}${index}`) ?? (missing.add(match), match));
    if (missing.size) throw new Error(`提示词里引用了 ${[...missing].join("、")}，但没有对应的参考素材`);
    return text;
}

/** 系统提示词拼在前面（和画布原来的做法一样）。 */
function fitPrompt(profile: ModelProfile, config: FitValuesConfig, prompt: string) {
    const system = ((profile.kind === "video" ? config.systemPrompts?.video : config.systemPrompts?.image) || config.systemPrompt || "").trim();
    return system ? `${system}\n\n${prompt}` : prompt;
}

function mimeOf(dataUrl: string) {
    return /^data:([^;,]+)/i.exec(dataUrl)?.[1] || "";
}

export async function imageAsset(image: ReferenceImage) {
    const dataUrl = image.dataUrl?.startsWith("data:") ? image.dataUrl : await (await import("@/services/image-storage")).imageToDataUrl(image);
    if (!dataUrl) throw new Error(`读取参考图 ${image.name} 失败`);
    // 和 fit 生成台一样，超过 1280 边长或 2MB 的图先缩小成 JPEG 再发（浏览器外 downscaleImage 直接返回 null）
    const smaller = /^data:image\/[^;,]+;base64,/i.test(dataUrl) ? await downscaleImage(dataUrlToFile({ ...image, dataUrl })) : null;
    return smaller ? { name: smaller.name, mimeType: smaller.mimeType, dataUrl: smaller.dataUrl } : { mimeType: mimeOf(dataUrl) || image.type, dataUrl };
}

/**
 * 音视频读成 data URL，不把画布自己的存储链接发给上游。时长先实测（浏览器里用媒体元素读，读不出的要求时长的卡会被 validateSubmission 拦下），
 * 测不到才用素材自带的（画布节点的 mediaDurationMs，见 canvas-node-generation）。
 */
async function mediaAsset(media: ReferenceVideo | ReferenceAudio, kind: MediaKind) {
    const [{ readMediaDurationMs, resolveMediaUrl }, { fetchViaProxy }] = await Promise.all([import("@/services/file-storage"), import("@/services/image-storage")]);
    let blob: Blob | null = null;
    if (!media.url.startsWith("data:")) {
        const url = await resolveMediaUrl(media.storageKey, media.url);
        if (!url) throw new Error(`读取参考素材 ${media.name} 失败：找不到文件`);
        const response = await fetchViaProxy(url);
        if (!response.ok) throw new Error(`读取参考素材 ${media.name} 失败：${response.status}`);
        blob = await response.blob();
    }
    const dataUrl = blob ? await readFileAsDataUrl(new File([blob], media.name, { type: media.type || blob.type }), `读取参考素材 ${media.name} 失败`) : media.url;
    const durationMs = (await readMediaDurationMs(blob ?? dataUrl, kind)) ?? media.durationMs;
    return { mimeType: media.type || mimeOf(dataUrl), dataUrl, ...(durationMs ? { durationSeconds: durationMs / 1000 } : {}) };
}

/**
 * 首帧、尾帧、参考图、参考视频、参考音频按这个顺序对应 fit 的角色（参考图的顺序就是 @图N 的编号）。
 * 默认读内容；卡片不收的种类或用途不读，交给 validateSubmission 报「不接受」，不发请求。
 */
async function fitReferences(profile: ModelProfile, slots: Slot[], read?: FitMediaReader) {
    const references: FitReference[] = [];
    for (const [index, [kind, role, source]] of slots.entries()) {
        const base = { id: `${index}-${source.id}`, name: source.name, kind, role, mimeType: source.type, dataUrl: "" };
        if (read) references.push(await read(base, source));
        else if (!profile.referenceTypes.includes(kind) || !profile.roles.includes(role)) references.push(base);
        else if (kind === "image") references.push({ ...base, ...(await imageAsset(source as ReferenceImage)) });
        else references.push({ ...base, ...(await mediaAsset(source as ReferenceVideo | ReferenceAudio, kind)) });
    }
    return references;
}

/** 画布的清晰度对上卡片的写法，对不上取卡片默认值；时长范围跟着它走（secondsRuleAt）。 */
export function fitResolution(profile: ModelProfile, vquality?: string) {
    return pickResolution(profile.resolutions, vquality) ?? defaultFormValuesFor(profile).resolution;
}

/** 价格提示按当前设置估价用的清晰度和时长：和 fit 生成台传给 ModelPriceHint 的一样，固定时长的卡给固定值，其余按 canvasToFitValues 的换算。 */
export function fitPriceSelection(profile: ModelProfile, config: Pick<FitValuesConfig, "vquality" | "videoSeconds">) {
    const resolution = fitResolution(profile, config.vquality);
    return { resolution, seconds: profile.seconds?.mode === "fixed" ? profile.seconds.value : pickSeconds(secondsRuleAt(profile, resolution), config.videoSeconds) };
}

/**
 * 画布的参数换算成 fit 生成台的表单值，之后照 fit 的流程跑 validateSubmission → buildRelayRequest。
 * 时长、清晰度、画幅、图片尺寸对不上卡片时取卡片默认值（defaultFormValuesFor）；参考素材全部读成 data URL（read 可换掉读法）。
 */
export async function canvasToFitValues(profile: ModelProfile, config: FitValuesConfig, prompt: string, input: FitReferenceInput = {}, read?: FitMediaReader): Promise<GenerationFormValues> {
    const defaults = defaultFormValuesFor(profile);
    const resolution = fitResolution(profile, config.vquality);
    const slots: Slot[] = [
        ...(input.firstFrame ? [["image", "first_frame", input.firstFrame] as const] : []),
        ...(input.lastFrame ? [["image", "last_frame", input.lastFrame] as const] : []),
        ...(input.references ?? []).map((image) => ["image", "reference", image] as const),
        ...(input.videoReferences ?? []).map((video) => ["video", "reference", video] as const),
        ...(input.audioReferences ?? []).map((audio) => ["audio", "reference", audio] as const),
    ];
    const references = await fitReferences(profile, slots, read);
    // 画幅按这个清晰度下可选的取（aspectRatiosAt）；卡片默认画幅在这个清晰度下没有时取第一个可选的
    const ratios = aspectRatiosAt(profile, resolution);
    return {
        prompt: fitPrompt(profile, config, fitMentions(prompt, slots, references, config.fitMentionLabels)),
        seconds: pickSeconds(secondsRuleAt(profile, resolution), config.videoSeconds),
        resolution,
        aspectRatio: pickAspectRatio(ratios, config.size) ?? (defaults.aspectRatio && ratios.includes(defaults.aspectRatio) ? defaults.aspectRatio : (ratios[0] ?? defaults.aspectRatio)),
        imageSize: pickImageSize(profile, config) ?? defaults.imageSize,
        references,
        advanced: pickAdvanced(profile, config),
    };
}

/** validateSubmission 的问题译成中文（fit 的 zh 文案，{{x}} 插值），多条用「；」连接。 */
export function fitIssueText(issues: SubmissionIssue[]) {
    return issues
        .map(({ key, values = {} }) =>
            (zh[key] ?? key).replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
                const value = values[name];
                if (value == null) return match;
                if (name === "role") return ROLE_LABELS[value] ?? String(value);
                return name === "kind" || name === "field" ? (zh[value] ?? String(value)) : String(value);
            }),
        )
        .join("；");
}
