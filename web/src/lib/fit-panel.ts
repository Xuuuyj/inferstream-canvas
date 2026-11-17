import { isFitConfig } from "@/lib/fit-config";
import { formatImageSizeOption, MAX_POLL_FAILURES } from "@/lib/fit-generate/constants";
import { aspectRatiosAt, customerAdvancedParams, secondsRuleAt } from "@/lib/fit-generate/lib/model-profiles";
import { allowsReferenceOnlySubmission, validateSubmission } from "@/lib/fit-generate/lib/validate-submission";
import messages from "@/lib/fit-generate/messages.zh.json";
import type { AdvancedParam, AdvancedValues, GenerationFormValues, ModelProfile, ReferenceAssetKind } from "@/lib/fit-generate/types";
import { canvasToFitValues, fitIssueText, fitResolution, type FitMediaReader, type FitReferenceInput, type FitValuesConfig } from "@/services/api/fit/values";
import { FitRequestError } from "@/services/api/fit/video";
import type { AiConfig } from "@/stores/use-config-store";

/** 面板写回画布配置的键：都写 fit 的原值（720P、16:9、2048x1152，Gemini 的 0.5K/1K/2K/4K 写进 quality），fitAdvanced 写对象；换算规则见 values.ts。 */
export type FitPanelKey = "videoSeconds" | "vquality" | "size" | "quality" | "count" | "fitAdvanced";
/** value 是 fit 的原值，write 是选中后写进 key 的值（现在都等于原值）。 */
export type FitChoice = { value: string; label: string; write: string };
export type FitChoiceGroup = { title: string; key: "vquality" | "size" | "quality"; value: string | null; options: FitChoice[] };
export type FitSeconds = { mode: "fixed"; value: number } | { mode: "steps"; options: number[]; value: number } | { mode: "range"; min: number; max: number; value: number };
export type FitAdvancedControl = { param: AdvancedParam; label: string; value: boolean | number | string | undefined; options: FitChoice[] };
/** 参数面板按 fit 卡片的 profile 显示哪些控件；没有的项（Kling 元素、多镜头、运动控制、人物朝向、自动时长、声音、水印）一律不出现。 */
export type FitPanel = { seconds: FitSeconds | null; groups: FitChoiceGroup[]; advanced: FitAdvancedControl[]; references: string; hint: string };

const zh = messages as Record<string, string>;
const CHOICE_LABELS: Record<string, string> = { auto: "自动", low: "低", medium: "中", high: "高", xhigh: "极高" };
const KIND_LABELS: Record<ReferenceAssetKind, string> = { image: "图片", video: "视频", audio: "音频" };
/** 预检不读素材内容，给每个素材一个能通过「可发送链接」检查的占位地址。 */
const PRECHECK_URL = "https://openai.fit/precheck";
const UNREAD_LENGTH = "The length of {{name}} could not be read; {{kind}} references need a known length of {{min}}-{{max}} s";

const resolutionLabel = (value: string) => (value === "standard" ? "标准" : value);
const ratioLabel = (value: string) => (value === "adaptive" ? "自适应" : value);
const choices = (values: string[], label: (value: string) => string) => values.map((value) => ({ value, label: label(value), write: value }));

function secondsControl(profile: ModelProfile, values: GenerationFormValues): FitSeconds | null {
    const rule = secondsRuleAt(profile, values.resolution);
    if (!rule) return null;
    if (rule.mode === "fixed") return { mode: "fixed", value: rule.value };
    const value = values.seconds ?? rule.defaultValue;
    return rule.steps?.length ? { mode: "steps", options: rule.steps, value } : { mode: "range", min: rule.min, max: rule.max, value };
}

/** 只给客户可选的几项（customerAdvancedParams，同 fit 生成台）；没选过的显示卡片默认值。 */
function advancedControls(profile: ModelProfile, values: GenerationFormValues): FitAdvancedControl[] {
    return customerAdvancedParams(profile)
        .filter((param) => param.kind === "boolean" || param.kind === "choice")
        .map((param) => ({
            param,
            label: zh[param.labelKey] ?? param.labelKey,
            value: values.advanced[param.key] ?? (param.kind === "choice" ? param.defaultValue : param.kind === "boolean" ? param.defaultValue === true : undefined),
            options: param.kind === "choice" ? param.options.map((option) => ({ value: option.value, label: CHOICE_LABELS[option.value] ?? zh[option.labelKey] ?? option.labelKey, write: option.value })) : [],
        }));
}

function referencesHint(profile: ModelProfile) {
    const { limits } = profile;
    const kinds = profile.referenceTypes.filter((kind) => limits[kind] > 0).map((kind) => `${KIND_LABELS[kind]} ${limits[kind]}`);
    const frames = profile.roles.filter((role) => role !== "reference").map((role) => (role === "first_frame" ? "首帧 1" : "尾帧 1"));
    if (limits.total <= 0 || (!kinds.length && !frames.length)) return "这个模型不收参考素材";
    const notes = [profile.requiresFirstFrame ? "必须有首帧" : "", limits.minImages ? `至少 ${limits.minImages} 张参考图` : ""].filter(Boolean);
    return `参考素材最多 ${limits.total} 个：${[...kinds, ...frames].join(" · ")}${notes.length ? `；${notes.join("，")}` : ""}`;
}

/**
 * values 是 canvasToFitValues 换算出的、真正会发出去的表单值，面板高亮的就是它。
 * visualOnly（助手输入框）只给清晰度和画幅；showSize 为 false（全景图）时不给尺寸和画幅。
 */
export function fitPanel(profile: ModelProfile, values: GenerationFormValues, { visualOnly = false, showSize = true } = {}): FitPanel {
    const groups: FitChoiceGroup[] =
        profile.kind === "video"
            ? [
                  { title: "清晰度", key: "vquality", value: values.resolution, options: choices(profile.resolutions, resolutionLabel) },
                  // 有的卡在某个清晰度下少几种画幅（wan3.0-video 720P 没有自适应），按当前清晰度列，同 fit 生成台
                  { title: "画幅", key: "size", value: values.aspectRatio, options: choices(aspectRatiosAt(profile, values.resolution), ratioLabel) },
              ]
            : profile.imageApi === "gemini-image"
              ? [
                    // 和 fit 生成台一样列出卡片的全部档位（gemini-3.1-flash-image-preview 还有 0.5K），写卡片原值
                    { title: "清晰度", key: "quality", value: values.imageSize, options: choices(profile.imageSizes, String) },
                    ...(showSize ? [{ title: "画幅", key: "size" as const, value: values.aspectRatio, options: choices(profile.aspectRatios, ratioLabel) }] : []),
                ]
              : showSize
                ? [{ title: "尺寸", key: "size", value: values.imageSize, options: choices(profile.imageSizes, formatImageSizeOption) }]
                : [];
    const visible = groups.filter((group) => group.options.length > 0);
    if (visualOnly) return { seconds: null, groups: visible, advanced: [], references: "", hint: "" };
    return { seconds: secondsControl(profile, values), groups: visible, advanced: advancedControls(profile, values), references: referencesHint(profile), hint: (profile.promptHintKey && zh[profile.promptHintKey]) || "" };
}

/** 设置按钮上的一行摘要，例如「720P · 16:9 · 15s」「中 · 2K · 16:9」「2K · 16:9」。 */
export function fitPanelSummary(profile: ModelProfile, values: GenerationFormValues, withSeconds = true) {
    if (profile.kind === "video") {
        const seconds = withSeconds ? secondsControl(profile, values) : null;
        return [values.resolution && resolutionLabel(values.resolution), values.aspectRatio && ratioLabel(values.aspectRatio), seconds && `${seconds.value}s`].filter(Boolean).join(" · ");
    }
    if (profile.imageApi === "gemini-image") return [values.imageSize, values.aspectRatio && ratioLabel(values.aspectRatio)].filter(Boolean).join(" · ");
    const quality = advancedControls(profile, values).find((control) => control.param.key === "quality" && control.options.length > 1);
    const size = values.imageSize === "auto" ? "自动尺寸" : values.imageSize && formatImageSizeOption(values.imageSize).replace(/（.*$/, "");
    return [quality?.options.find((option) => option.value === quality.value)?.label, size].filter(Boolean).join(" · ");
}

/** 助手看的可选时长，按卡片在这个清晰度下的时长规则（secondsRuleAt），和参数面板一致。 */
export function fitVideoDurationHint(profile: ModelProfile, vquality?: string) {
    const rule = secondsRuleAt(profile, fitResolution(profile, vquality));
    if (!rule) return { range: "这个模型没有时长参数" };
    if (rule.mode === "fixed") return { values: [rule.value], range: `固定 ${rule.value} 秒` };
    return rule.steps?.length ? { values: rule.steps, range: `仅 ${rule.steps.join("、")} 秒` } : { min: rule.min, max: rule.max, range: `${rule.min}-${rule.max} 秒内任意整数秒` };
}

/** 助手给的时长不合卡片规则时的原因；-1（自动）用卡片默认时长，固定时长的卡不管传多少都按卡片发，都不拦。 */
export function fitVideoSecondsIssue(profile: ModelProfile, vquality: string | undefined, seconds: number) {
    if (!Number.isInteger(seconds)) return "视频总时长必须为整数秒";
    const rule = secondsRuleAt(profile, fitResolution(profile, vquality));
    if (rule?.mode !== "range" || seconds === -1) return "";
    if (rule.steps?.length) return rule.steps.includes(seconds) ? "" : `当前视频模型仅支持 ${rule.steps.join("、")} 秒`;
    return seconds >= rule.min && seconds <= rule.max ? "" : `当前视频模型仅支持 ${rule.min}-${rule.max} 秒`;
}

/** 改一个高级参数，规则同 fit 生成台：清空的值、关掉的开关（没有显式默认值时）直接删掉，不发。 */
export function fitAdvancedPatch(profile: ModelProfile, current: AdvancedValues | undefined, key: string, value: boolean | number | string | undefined): AdvancedValues {
    const next = { ...current };
    const param = profile.advanced.find((item) => item.key === key);
    const keepsFalse = param?.kind === "boolean" && param.defaultValue != null;
    if (value === undefined || value === "" || (value === false && !keepsFalse)) delete next[key];
    else next[key] = value;
    return next;
}

/**
 * 画布轮询 openai.fit 视频任务出错后怎么办，同 fit 生成台：临时错误（断网、408、429、5xx，即 FitRequestError.retryable）接着等、不计数；
 * 其他错误按 key（节点 + 任务号）连续累计，满 MAX_POLL_FAILURES（5）次返回失败原因，由调用方把节点标成失败；查成功一次由调用方 failures.delete(key) 清零。
 * 提交还没返回时节点上只有画布自己的 client_ 任务号，fit/video.ts 不发请求直接抛错，这种不算。还没到失败时返回空串。
 */
export function fitPollFailure(failures: Map<string, number>, key: string, taskId: string, error: unknown) {
    if (taskId.startsWith("client_") || (error instanceof FitRequestError && error.retryable)) return "";
    const count = (failures.get(key) ?? 0) + 1;
    if (count < MAX_POLL_FAILURES) {
        failures.set(key, count);
        return "";
    }
    failures.delete(key);
    return (error instanceof Error && error.message) || "查询视频任务失败";
}

/** 预检的读法：地址用 PRECHECK_URL，音视频时长只用素材自带的（画布生成的节点出片时记下了 mediaDurationMs 才带，见 canvas-node-generation）。 */
const precheckReader: FitMediaReader = async (base, source) => {
    const durationMs = "durationMs" in source ? source.durationMs : undefined;
    return { ...base, dataUrl: PRECHECK_URL, ...(durationMs ? { durationSeconds: durationMs / 1000 } : {}) };
};

/**
 * 点「生成」前的快速校验：和提交走同一个 canvasToFitValues（素材顺序、用途、@ 引用改写都一样），只是不读素材内容，再跑 fit 的 validateSubmission。
 * 读不出时长的问题留给视频接口读完素材后再判断；其余问题在这里就拦下，不建节点、不发请求。没有问题返回空串。
 */
export async function fitPrecheck(profile: ModelProfile, config: FitValuesConfig, prompt: string, input: FitReferenceInput = {}) {
    try {
        const values = await canvasToFitValues(profile, config, prompt, input, precheckReader);
        return fitIssueText(validateSubmission(profile, values).filter((issue) => issue.key !== UNREAD_LENGTH));
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

/**
 * 能不能不写提示词、只发素材：照 fit 生成台（allowsReferenceOnlySubmission，fit 5c1c13d 只放行 seedance 2.5-GT），这张卡收下的参考素材里有一个就行。
 * 素材按 canvasToFitValues 的顺序和用途对应（首帧、尾帧、参考图、视频、音频），地址用 PRECHECK_URL（真正提交时才读内容）。
 * 视频工作台和画布图片、视频节点共用；不是 fit 配置、走工作流（videoWorkflowRef）或卡片还没读到时返回 false，照旧要提示词。
 */
export function fitAllowsEmptyPrompt(config: AiConfig, profile: ModelProfile | null, input: FitReferenceInput) {
    if (!profile || config.videoWorkflowRef || !isFitConfig(config)) return false;
    const slots = [
        ...(input.firstFrame ? [["image", "first_frame", input.firstFrame] as const] : []),
        ...(input.lastFrame ? [["image", "last_frame", input.lastFrame] as const] : []),
        ...(input.references ?? []).map((item) => ["image", "reference", item] as const),
        ...(input.videoReferences ?? []).map((item) => ["video", "reference", item] as const),
        ...(input.audioReferences ?? []).map((item) => ["audio", "reference", item] as const),
    ];
    return allowsReferenceOnlySubmission(
        profile,
        slots.map(([kind, role, item]) => ({ id: item.id, name: item.name, mimeType: item.type, kind, role, dataUrl: PRECHECK_URL })),
    );
}
