import { FIT_CHANNEL_ID, FIT_ORIGIN } from "@/lib/model-channel";
import { classifyFitModels, fitModelKind, type FitModelList } from "@/lib/fit-models";
import type { AiConfig, FitAccount, FitKeySlot, FitKind, LocalModelChannel } from "@/stores/use-config-store";

const FIT_HOST = new URL(FIT_ORIGIN).host;

/** 第 C20 条：这些字段永远不上传到画布服务器，也不从服务器回填。三把令牌（fitKeys，槽位里的密钥字段也叫 apiKey）、手动令牌和令牌属于哪个 fit 用户同样只留在浏览器。 */
export const SYNC_SECRET_KEYS = ["apiKey", "baseUrl", "localChannels", "publicChannels", "channelTranslations", "uploadApiKey", "fitKeys", "fitManualKey", "fitAccount"] as const;
const secretKeys = new Set<string>(SYNC_SECRET_KEYS);
const localOnlyKeys = new Set<string>([
    ...SYNC_SECRET_KEYS,
    "channelMode",
    "models",
    "imageModels",
    "videoModels",
    "textModels",
    "audioModels",
    "activeChannelId",
    "imageChannelId",
    "videoChannelId",
    "textChannelId",
    "audioChannelId",
    "fitTokenName",
    "fitTokenExpiresAt",
    "fitTokenCheckedAt",
    "workflowChannels",
    "workflowSyncTouched",
]);

/** 三类令牌，顺序就是设置里下拉框的顺序。语音不单独占槽位，跟文本走同一把。 */
export const FIT_KINDS: readonly FitKind[] = ["video", "image", "text"];
export const FIT_KIND_LABELS: Record<FitKind, string> = { video: "视频", image: "图片", text: "文本" };
const fitApiKeyPattern = /^sk-[A-Za-z0-9_-]{16,256}$/;

type FitKeyConfig = Partial<Pick<AiConfig, "fitKeys" | "fitManualKey">>;

export function isFitBaseUrl(value: string | null | undefined) {
    try {
        const url = new URL((value || "").trim());
        return url.protocol === "https:" && url.host === FIT_HOST && !url.username && !url.password && !url.search && !url.hash && /^\/(v1\/?)?$/.test(url.pathname);
    } catch {
        return false;
    }
}

export function normalizeFitApiKey(value: string | null | undefined) {
    const key = (value || "").trim();
    return !key || key.startsWith("sk-") ? key : `sk-${key}`;
}

/** openai.fit 令牌的格式（sk- 加 16–256 位 base64url 字符）：桥接页取回的密钥和存下的槽位都按它校验。 */
export function isFitApiKey(value: unknown): value is string {
    return typeof value === "string" && fitApiKeyPattern.test(value);
}

/** 缺令牌时的提示，按类型说清楚缺的是哪一把。 */
export function missingFitKeyMessage(kind: FitKind) {
    return `缺少可用的${FIT_KIND_LABELS[kind]}令牌，请在设置中查看模型服务状态`;
}

/** 这类请求用的令牌：手动令牌优先（三类共用），否则用这一类的槽位。 */
export function fitKeyFor(config: FitKeyConfig, kind: FitKind) {
    return normalizeFitApiKey(config.fitManualKey) || config.fitKeys?.[kind]?.apiKey || "";
}

/**
 * 模型属于哪一类令牌：先看 openai.fit 渠道里同步来的类型（语音归文本），查不到时按名字（和 fit 模型分类的名字规则一致）。
 * 名字规则用 fit-models 的 fitModelKind，不从配置 store 引 modelMatchesCapability：store 本身引用本文件，互相引用会让 store 恢复本地配置时读到还没初始化的常量。
 */
export function fitKindOfModel(config: Partial<Pick<AiConfig, "localChannels">>, model: string): FitKind {
    const saved = (Array.isArray(config.localChannels) ? config.localChannels : []).find((channel) => channel?.id === FIT_CHANNEL_ID);
    const capability = saved?.modelCapabilities && Object.hasOwn(saved.modelCapabilities, model) ? saved.modelCapabilities[model] : undefined;
    if (capability === "video" || capability === "image") return capability;
    if (capability === "text" || capability === "audio") return "text";
    const kind = fitModelKind({ id: model });
    return kind === "video" || kind === "image" ? kind : "text";
}

export function fitKeyForModel(config: FitKeyConfig & Partial<Pick<AiConfig, "localChannels">>, model: string) {
    return fitKeyFor(config, fitKindOfModel(config, model));
}

/** 三类各自的令牌（可能重复、可能为空），给 loadFitStudio 按类型合并模型列表用。 */
export function fitKeySet(config: FitKeyConfig): Record<FitKind, string> {
    return { video: fitKeyFor(config, "video"), image: fitKeyFor(config, "image"), text: fitKeyFor(config, "text") };
}

/** 三类令牌都有了（手动令牌一把顶三把）。 */
export function fitKeysComplete(config: FitKeyConfig) {
    return Boolean(normalizeFitApiKey(config.fitManualKey)) || FIT_KINDS.every((kind) => Boolean(config.fitKeys?.[kind]?.apiKey));
}

/** 浏览器里存着任何一把令牌（手动或槽位）。 */
export function hasAnyFitKey(config: FitKeyConfig) {
    return Boolean(normalizeFitApiKey(config.fitManualKey)) || FIT_KINDS.some((kind) => Boolean(config.fitKeys?.[kind]?.apiKey));
}

/** 模型列表存在浏览器里，上次同步超过这么久，打开页面或切回标签页时重新拉一次（fit 上新、下架的模型跟着变）。 */
export const FIT_MODELS_STALE_MS = 10 * 60_000;

/** 有令牌、同步过、而且已超过 FIT_MODELS_STALE_MS：该静默重拉模型列表。从没同步过的由桥接页和设置弹窗负责，不算。 */
export function fitModelsStale(config: FitKeyConfig & Partial<Pick<AiConfig, "fitTokenCheckedAt">>, now = Date.now()) {
    return hasAnyFitKey(config) && Boolean(config.fitTokenCheckedAt) && now - (config.fitTokenCheckedAt ?? 0) >= FIT_MODELS_STALE_MS;
}

/** 浏览器里的槽位令牌是桥接页按某个 fit 账号取来的（记着 fitAccount）：fit 退出或换人时要清掉它们（手动令牌不算）。 */
export function hasBridgeFitKeys(config: FitKeyConfig & Partial<Pick<AiConfig, "fitAccount">>) {
    return Boolean(config.fitAccount) && FIT_KINDS.some((kind) => Boolean(config.fitKeys?.[kind]?.apiKey));
}

/** 画布顶栏钥匙按钮上的字：手动令牌 / 令牌已就绪 / 令牌待同步 / 未连接（退出后不自动连 openai.fit）/ 登录 openai.fit / 令牌未选全。 */
export function fitKeyStatusLabel(config: FitKeyConfig & Pick<AiConfig, "fitTokenCheckedAt">, bridge: { autoLoginOff: boolean; fitLoggedIn: boolean | null }) {
    if (normalizeFitApiKey(config.fitManualKey)) return "手动令牌";
    if (fitKeysComplete(config)) return config.fitTokenCheckedAt ? "令牌已就绪" : "令牌待同步";
    if (bridge.autoLoginOff) return "未连接";
    if (!hasAnyFitKey(config) && bridge.fitLoggedIn === false) return "模型服务未连接";
    return "令牌未选全";
}

/** 钥匙按钮的提示：三把令牌各是哪一把（只保存在本浏览器）。 */
export function fitKeyStatusTooltip(config: FitKeyConfig) {
    const manual = normalizeFitApiKey(config.fitManualKey);
    if (manual) return "视频、图片、文本都用手动填写的令牌（只保存在本浏览器）";
    return `${FIT_KINDS.map((kind) => `${FIT_KIND_LABELS[kind]}：${config.fitKeys?.[kind]?.name || "未选"}`).join(" · ")}（只保存在本浏览器）`;
}

/** 提交任务时记下用的是哪把令牌（"manual" 或 "t:<令牌 id>"），轮询和下载时按它找回同一把。 */
export function fitKeyRef(config: FitKeyConfig, kind: FitKind) {
    if (normalizeFitApiKey(config.fitManualKey)) return "manual";
    const slot = config.fitKeys?.[kind];
    return slot?.apiKey ? `t:${slot.tokenId}` : "";
}

/**
 * 按提交时记下的 ref 找令牌：t:<id> 先找令牌 id 相同的槽位；找不到就用手动令牌，再不行用视频令牌。
 * openai.fit 按用户查任务，同一个账号的任意一把令牌都能查到，所以换过槽位也能接着轮询。
 */
export function fitKeyForRef(config: FitKeyConfig, ref: string | undefined) {
    const id = /^t:(\d+)$/.exec(ref || "")?.[1];
    const slot = id ? FIT_KINDS.map((kind) => config.fitKeys?.[kind]).find((item) => item?.apiKey && String(item.tokenId) === id) : undefined;
    return slot?.apiKey || normalizeFitApiKey(config.fitManualKey) || fitKeyFor(config, "video");
}

function validSlot(value: unknown): FitKeySlot | null {
    const slot = value as Partial<FitKeySlot> | null;
    if (!slot || typeof slot !== "object" || !Number.isSafeInteger(slot.tokenId) || Number(slot.tokenId) <= 0 || !isFitApiKey(slot.apiKey)) return null;
    return { tokenId: Number(slot.tokenId), name: typeof slot.name === "string" ? slot.name : "", group: typeof slot.group === "string" ? slot.group : "", apiKey: slot.apiKey };
}

/** 本地存的配置里还有旧版的明文令牌（顶层 apiKey，或存在渠道里的 apiKey）：读进来以后要马上按新格式写回一次，把它们从存储里抹掉。 */
export function hasLegacyStoredKey(persisted: Partial<AiConfig> & { apiKey?: unknown }) {
    const filled = (value: unknown) => typeof value === "string" && Boolean(value.trim());
    return filled(persisted.apiKey) || (Array.isArray(persisted.localChannels) && persisted.localChannels.some((channel) => filled(channel?.apiKey)));
}

/**
 * 读本地存的配置时整理令牌：旧版只有一把 apiKey，手动令牌为空时迁移成手动令牌（三类都用它）；结果里没有 apiKey，调用方丢掉旧字段；
 * 三个槽位逐个校验（令牌 id 是正整数、密钥格式对），不合格的丢掉。
 */
export function migrateFitKeys(persisted: Partial<AiConfig> & { apiKey?: unknown }): Pick<AiConfig, "fitKeys" | "fitManualKey" | "fitAccount"> {
    const legacy = typeof persisted.apiKey === "string" ? normalizeFitApiKey(persisted.apiKey) : "";
    const manual = typeof persisted.fitManualKey === "string" ? persisted.fitManualKey : "";
    const fitKeys: Partial<Record<FitKind, FitKeySlot>> = {};
    for (const kind of FIT_KINDS) {
        const slot = validSlot(persisted.fitKeys?.[kind]);
        if (slot) fitKeys[kind] = slot;
    }
    const account = persisted.fitAccount as Partial<FitAccount> | undefined;
    const fitAccount: FitAccount | undefined =
        account && Number.isSafeInteger(account.userId) && Number(account.userId) > 0
            ? { userId: Number(account.userId), displayName: typeof account.displayName === "string" ? account.displayName : "", ...(Number.isSafeInteger(account.checkedAt) && Number(account.checkedAt) > 0 ? { checkedAt: Number(account.checkedAt) } : {}) }
            : undefined;
    return { fitKeys, fitManualKey: manual.trim() ? manual : legacy, fitAccount };
}

/** 唯一的渠道：模型列表只沿用之前保存的 openai.fit 渠道，其他渠道一律丢弃。渠道里不存令牌，用的时候按模型类型现算（见 normalizeLocalChannels）。 */
export function fitChannel(config: Partial<AiConfig>): LocalModelChannel {
    const saved = (Array.isArray(config.localChannels) ? config.localChannels : []).find((channel) => channel?.id === FIT_CHANNEL_ID);
    return {
        id: FIT_CHANNEL_ID,
        protocol: "openai",
        name: "openai.fit",
        baseUrl: FIT_ORIGIN,
        apiKey: "",
        models: Array.isArray(saved?.models) ? saved.models.filter(Boolean) : [],
        modelCapabilities: saved?.modelCapabilities || {},
    };
}

export function isFitConfig(config: Partial<Pick<AiConfig, "activeChannelId" | "localChannels" | "baseUrl">>) {
    return config.activeChannelId === FIT_CHANNEL_ID || Boolean(config.localChannels?.some((channel) => channel.id === FIT_CHANNEL_ID)) || isFitBaseUrl(config.baseUrl);
}

export function normalizeFitConfig(config: AiConfig): AiConfig {
    const channel = fitChannel(config);
    return {
        ...config,
        channelMode: "local",
        baseUrl: FIT_ORIGIN,
        localChannels: [channel],
        publicChannels: [],
        models: channel.models,
        activeChannelId: FIT_CHANNEL_ID,
        imageChannelId: FIT_CHANNEL_ID,
        videoChannelId: FIT_CHANNEL_ID,
        textChannelId: FIT_CHANNEL_ID,
        audioChannelId: FIT_CHANNEL_ID,
    };
}

/** 换手动令牌时旧令牌的名字和同步结果作废，模型列表等「验证并同步模型」后再刷新。 */
export function withFitManualKey(config: AiConfig, apiKey: string): AiConfig {
    if (apiKey === config.fitManualKey) return config;
    return { ...config, fitManualKey: apiKey, fitTokenName: "", fitTokenExpiresAt: 0, fitTokenCheckedAt: 0 };
}

/** 换某一类的令牌（null 是清空这一类）：密钥变了模型列表就要重新同步。 */
export function withFitKeySlot(config: AiConfig, kind: FitKind, slot: FitKeySlot | null): AiConfig {
    const fitKeys = { ...config.fitKeys };
    if (slot) fitKeys[kind] = slot;
    else delete fitKeys[kind];
    const changed = config.fitKeys?.[kind]?.apiKey !== slot?.apiKey;
    return { ...config, fitKeys, ...(changed ? { fitTokenCheckedAt: 0 } : {}) };
}

export type FitModelsUpdate = { list: FitModelList; tokenName?: string; expiresAt?: number; checkedAt?: number };

export function applyFitModels(config: AiConfig, { list, tokenName = "", expiresAt = 0, checkedAt = 0 }: FitModelsUpdate): AiConfig {
    const modelsOf = (kind: string) => list.models.filter((model) => list.modelCapabilities[model] === kind);
    const pick = (current: string, models: string[]) => (models.includes(current) ? current : models[0] || "");
    const imageModels = modelsOf("image");
    const videoModels = modelsOf("video");
    const textModels = modelsOf("text");
    const audioModels = modelsOf("audio");
    const base = normalizeFitConfig(config);
    return {
        ...base,
        localChannels: [{ ...base.localChannels[0], models: list.models, modelCapabilities: list.modelCapabilities }],
        models: list.models,
        imageModels,
        videoModels,
        textModels,
        audioModels,
        imageModel: pick(config.imageModel, imageModels),
        videoModel: pick(config.videoModel, videoModels),
        textModel: pick(config.textModel, textModels),
        audioModel: pick(config.audioModel, audioModels),
        fitTokenName: tokenName,
        fitTokenExpiresAt: expiresAt,
        fitTokenCheckedAt: checkedAt,
    };
}

/** 清除令牌（退出时选「退出并清除令牌」）：三把令牌、手动令牌、令牌属于谁和模型列表都回到没令牌的样子。 */
export function withoutFitKeys(config: AiConfig): AiConfig {
    return applyFitModels({ ...config, fitKeys: {}, fitManualKey: "", fitAccount: undefined }, { list: classifyFitModels([], null) });
}

/** fit 退出或换了人：清掉桥接页取来的三把令牌和它们属于谁，手动令牌保留（没有手动令牌时模型列表一起回到没令牌的样子）。 */
export function withoutBridgeFitKeys(config: AiConfig): AiConfig {
    if (normalizeFitApiKey(config.fitManualKey)) return { ...config, fitKeys: {}, fitAccount: undefined };
    return withoutFitKeys(config);
}

/** 主动点「退出登录」时，浏览器里存着任何一把 openai.fit 令牌就先问清不清（公用电脑上下一个人能用它花钱）；没存令牌直接退出。 */
export function logoutAsksAboutFitToken(config: FitKeyConfig) {
    return hasAnyFitKey(config);
}

/** 上传到画布服务器之前深度剔除 C20 的字段，令牌、渠道永远只留在浏览器。 */
export function stripSecretsForSync<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => stripSecretsForSync(item)) as T;
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key)).map(([key, item]) => [key, stripSecretsForSync(item)])) as T;
}

/** 从服务器回填时只取偏好设置，不回填令牌、渠道和模型列表。 */
export function syncedPreferences(modelConfig: object): Partial<AiConfig> {
    return stripSecretsForSync(Object.fromEntries(Object.entries(modelConfig).filter(([key]) => !localOnlyKeys.has(key)))) as Partial<AiConfig>;
}

/**
 * 画布账号退出、过期或换人时只重置随账号同步的偏好；openai.fit 令牌、渠道和模型列表是浏览器级设置，原样保留。
 * 默认模型回到 defaults 后，如果令牌的模型列表里没有，就换成列表里的第一个。
 */
export function resetAccountPreferences(config: AiConfig, defaults: AiConfig): AiConfig {
    const next = { ...defaults, ...Object.fromEntries(Object.entries(config).filter(([key]) => localOnlyKeys.has(key))) } as AiConfig;
    const pick = (current: string, models: string[]) => (models.length && !models.includes(current) ? models[0] : current);
    return { ...next, imageModel: pick(next.imageModel, next.imageModels), videoModel: pick(next.videoModel, next.videoModels), textModel: pick(next.textModel, next.textModels), audioModel: pick(next.audioModel, next.audioModels) };
}
