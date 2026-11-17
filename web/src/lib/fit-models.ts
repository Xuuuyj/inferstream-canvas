import { capabilityLookup, parseCapabilityFeed, type CapabilityLookup } from "@/lib/fit-generate/lib/capability-feed";
import { buildStudioModels } from "@/lib/fit-generate/lib/model-profiles";
import type { PricingModel as FitPriceModel } from "@/lib/fit-generate/pricing/types";
import type { PricingModel } from "@/lib/fit-generate/shims/pricing-types";
import type { ModelProfile } from "@/lib/fit-generate/types";
import type { ModelCapabilities, ModelCapability } from "@/stores/use-config-store";

/** GET https://openai.fit/v1/models 里的一项。 */
export type FitTokenModel = { id: string; supported_endpoint_types?: string[] | null };
/**
 * GET /api/fit/catalog 的 data（第三节第 4 条）；价目表条目是 fit 生成库读的那四个字段，加上 enable_groups（哪些令牌分组能用，给三把令牌自动预选），
 * 再加上 fit 价格库算价格读的计价字段（quota_type、billing_expr 等，见 lib/fit-price.ts）。groupRatio 是 fit 价目表顶层的分组倍率，status 是 fit /api/status 里的币种设置。
 */
export type FitPricingEntry = PricingModel & { enable_groups?: string[] | null } & Partial<Omit<FitPriceModel, keyof PricingModel | "enable_groups">>;
export type FitCatalog = { pricing: FitPricingEntry[]; capabilities: unknown; groupRatio?: Record<string, number> | null; status?: Record<string, unknown> | null; fetchedAt?: string | number; stale?: boolean };
/** profiles：显示出来的每个图片、视频模型的 fit 表单契约（fit 生成台 buildStudioModels 的结果）。 */
export type FitModelList = { models: string[]; modelCapabilities: ModelCapabilities; counts: Record<ModelCapability, number>; profiles: Record<string, ModelProfile> };

type CapabilityEntry = { id: string; kind?: unknown; family?: unknown };

const kinds: readonly ModelCapability[] = ["text", "image", "video", "audio"];
const imageEndpoints = ["image-generation", "image-edits"];
const textEndpoints = ["openai", "openai-response", "anthropic", "gemini"];
const hiddenEndpoints = ["embeddings", "jina-rerank"];

/** 能力目录拿不到或格式不对时返回 null，fit 生成库就退回打包的规则。 */
function feedLookup(capabilities: unknown): CapabilityLookup | null {
    try {
        return capabilityLookup(parseCapabilityFeed(capabilities));
    } catch {
        return null;
    }
}

function kindByName(model: string): ModelCapability {
    if (/video|seedance|sora|veo|kling|hailuo|minimax.?h3|vidu|pixverse|omni.?flash|wan\d/i.test(model)) return "video";
    if (/image|banana|seedream|dall-?e|flux|imagen|midjourney/i.test(model)) return "image";
    return "text";
}

/**
 * 类型优先级：能力目录的 kind > 名字含 tts/speech 归语音 > supported_endpoint_types > 按名字兜底；返回 null 表示不显示。
 * 接口类型沿用 fit 的 publicGenerationKind：image-generation / image-edits 是图片；gemini 接口的模型，名字像图片模型或价目表标签
 * 带「图像/图片」也是图片，要先于文本规则判断（目录拿不到时 gemini-nano-banana-2.1 这类只能靠名字）。
 */
export function fitModelKind(model: FitTokenModel, pricing?: FitPricingEntry, capability?: CapabilityEntry): ModelCapability | null {
    if (kinds.includes(capability?.kind as ModelCapability)) return capability!.kind as ModelCapability;
    if (/tts|speech/i.test(model.id)) return "audio";
    const endpoints = model.supported_endpoint_types?.length ? model.supported_endpoint_types : pricing?.supported_endpoint_types || [];
    if (endpoints.includes("openai-video")) return "video";
    if (endpoints.some((endpoint) => imageEndpoints.includes(endpoint))) return "image";
    if (endpoints.includes("gemini") && (kindByName(model.id) === "image" || /图像|图片/.test(pricing?.tags || ""))) return "image";
    if (endpoints.some((endpoint) => textEndpoints.includes(endpoint))) return "text";
    if (endpoints.some((endpoint) => hiddenEndpoints.includes(endpoint))) return null;
    return kindByName(model.id);
}

/** 目录拿不到时，用 /v1/models 的接口类型凑一条价目表条目；按名字认出的 gemini 图片模型补上图片标签，fit 生成库才认它是图片。 */
function pricingFromToken(model: FitTokenModel): PricingModel {
    return { model_name: model.id, supported_endpoint_types: model.supported_endpoint_types ?? null, ...(fitModelKind(model) === "image" ? { tags: "图像生成" } : {}) };
}

/**
 * 令牌能调的模型（/v1/models）按类型分好，写进 openai.fit 渠道（第 C6 条）。
 * 文本：/v1/models 里的全部文本模型，不和价目表求交（gpt-6 这类分组模型照样显示）。
 * 图片/视频以 fit 生成台的 profile 为准，类型也取 profile 的：必须在价目表里，并且 fit 的 buildStudioModels 能建出 profile
 * （能力目录明确停售的 hiddenByFeed 已被它拿掉）；能力目录拿到时，视频还必须有条目且 family 不是 unsupported（fit 写着「暂不可生成」的占位）。
 * 能力目录拿不到时按打包的规则建 profile；整个目录都拿不到时，文本照常显示，图片和视频按接口类型凑价目表条目建 profile，不卡住用户。
 */
export function classifyFitModels(tokenModels: FitTokenModel[], catalog: FitCatalog | null): FitModelList {
    const pricing = Array.isArray(catalog?.pricing) ? new Map(catalog.pricing.map((entry) => [entry.model_name, entry])) : null;
    const lookup = feedLookup(catalog?.capabilities);
    const unique = new Map<string, FitTokenModel>();
    for (const model of tokenModels) {
        const id = model?.id?.trim();
        if (id && !unique.has(id)) unique.set(id, { ...model, id });
    }
    const priced = [...unique.values()].flatMap((model) => (pricing ? (pricing.get(model.id) ?? []) : [pricingFromToken(model)]));
    const studio = new Map(buildStudioModels(priced, lookup).map(({ profile }) => [profile.modelName, profile]));
    const modelCapabilities: ModelCapabilities = {};
    const profiles: Record<string, ModelProfile> = {};
    for (const model of unique.values()) {
        const entry = lookup?.get(model.id);
        const profile = studio.get(model.id);
        const kind = profile?.kind ?? fitModelKind(model, pricing?.get(model.id), entry);
        if (!kind) continue;
        if (kind === "image" || kind === "video") {
            if (!profile) continue;
            if (kind === "video" && lookup && (!entry || entry.family === "unsupported")) continue;
            profiles[model.id] = profile;
        }
        modelCapabilities[model.id] = kind;
    }
    const models = Object.keys(modelCapabilities).sort((a, b) => a.localeCompare(b));
    const counts = Object.fromEntries(kinds.map((kind) => [kind, models.filter((model) => modelCapabilities[model] === kind).length])) as Record<ModelCapability, number>;
    return { models, modelCapabilities, counts, profiles };
}
