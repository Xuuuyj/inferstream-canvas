import { FIT_KINDS, normalizeFitApiKey } from "@/lib/fit-config";
import type { ModelProfile } from "@/lib/fit-generate/types";
import { classifyFitModels, type FitCatalog, type FitModelList } from "@/lib/fit-models";
import { apiGet } from "@/services/api/request";
import type { FitKind, ModelCapability } from "@/stores/use-config-store";
import { validateFitToken } from "./token";

const CATALOG_TTL_MS = 60_000;
/** 三把令牌合并后的模型列表；errors 是验证失败的那几类（其余照常可用）。 */
export type FitStudio = FitModelList & { errors: Partial<Record<FitKind, string>> };
let cached: { at: number; request: Promise<FitCatalog> } | null = null;
let studio: { signature: string; at: number; request: Promise<FitStudio> } | null = null;
let latest: FitStudio | null = null;

/** 同源的 /api/fit/catalog（openai.fit 公开价目表和能力目录的镜像），浏览器内缓存 60 秒，失败的请求不缓存。 */
export function fetchFitCatalog() {
    if (cached && Date.now() - cached.at < CATALOG_TTL_MS) return cached.request;
    const request = apiGet<FitCatalog>("/api/fit/catalog");
    const entry = { at: Date.now(), request };
    cached = entry;
    request.catch(() => {
        if (cached === entry) cached = null;
    });
    return request;
}

/** 模型类型归哪一类令牌：语音跟文本走同一把。 */
const ownerOf = (capability: ModelCapability | undefined): FitKind | null => (capability === "audio" ? "text" : capability || null);

/**
 * 三把令牌合起来能用的模型和每个图片/视频模型的 fit 表单契约（规则见 classifyFitModels / 第 C6 条）：每把不重复的令牌各请求一次 /v1/models，
 * 视频模型（连同卡片）只取视频令牌的结果，图片只取图片令牌的，文本和语音只取文本令牌的。同一组令牌缓存 60 秒。
 * 某一把验证失败时照常返回其余几类，原因按类型放进 errors；全部失败才报 fit 的原因。目录拿不到不报错，退回打包的规则。失败的请求不缓存。
 */
export function loadFitStudio(keys: Record<FitKind, string>): Promise<FitStudio> {
    const normalized = { video: normalizeFitApiKey(keys.video), image: normalizeFitApiKey(keys.image), text: normalizeFitApiKey(keys.text) };
    const signature = FIT_KINDS.map((kind) => normalized[kind]).join("|");
    if (studio && studio.signature === signature && Date.now() - studio.at < CATALOG_TTL_MS) return studio.request;
    const request = mergeStudio(normalized);
    const entry = { signature, at: Date.now(), request };
    studio = entry;
    request.then(
        (list) => {
            if (studio === entry) latest = list;
        },
        () => {
            if (studio === entry) studio = null;
        },
    );
    return request;
}

async function mergeStudio(keys: Record<FitKind, string>): Promise<FitStudio> {
    const unique = [...new Set(FIT_KINDS.map((kind) => keys[kind]).filter(Boolean))];
    if (!unique.length) throw new Error("缺少可用的模型服务令牌");
    const catalogRequest = fetchFitCatalog().catch(() => null);
    const settled = await Promise.allSettled(unique.map((key) => validateFitToken(key)));
    const catalog = await catalogRequest;
    const lists = settled.map((result) => (result.status === "fulfilled" ? classifyFitModels(result.value, catalog) : null));
    if (lists.every((list) => !list)) throw (settled.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason ?? new Error("原模型服务令牌验证失败"));
    const modelCapabilities: FitModelList["modelCapabilities"] = {};
    const profiles: Record<string, ModelProfile> = {};
    const errors: FitStudio["errors"] = {};
    for (const kind of FIT_KINDS) {
        if (!keys[kind]) continue;
        const index = unique.indexOf(keys[kind]);
        const list = lists[index];
        const result = settled[index];
        if (!list) {
            errors[kind] = result.status === "rejected" && result.reason instanceof Error ? result.reason.message : "原模型服务令牌验证失败";
            continue;
        }
        for (const model of list.models) {
            if (ownerOf(list.modelCapabilities[model]) !== kind) continue;
            modelCapabilities[model] = list.modelCapabilities[model];
            if (Object.hasOwn(list.profiles, model)) profiles[model] = list.profiles[model];
        }
    }
    const models = Object.keys(modelCapabilities).sort((a, b) => a.localeCompare(b));
    const kinds: ModelCapability[] = ["text", "image", "video", "audio"];
    const counts = Object.fromEntries(kinds.map((kind) => [kind, models.filter((model) => modelCapabilities[model] === kind).length])) as Record<ModelCapability, number>;
    return { models, modelCapabilities, counts, profiles, errors };
}

/**
 * 清掉令牌的模型、卡片缓存和公开目录缓存（清除令牌时用），下次按新令牌重新读。
 * keepCatalog（重新验证令牌时用）只让下一次 loadFitStudio 重新请求 /v1/models，目录和上一份卡片留着，参数面板不闪。
 */
export function clearFitStudioCache({ keepCatalog = false }: { keepCatalog?: boolean } = {}) {
    studio = null;
    if (keepCatalog) return;
    cached = null;
    latest = null;
}

/** 最近一次 loadFitStudio 成功拿到的模型契约；先 await loadFitStudio(keys) 再取。不是图片/视频模型或令牌调不了时为 null。 */
export function fitProfileFor(model: string): ModelProfile | null {
    return (latest && Object.hasOwn(latest.profiles, model) && latest.profiles[model]) || null;
}
