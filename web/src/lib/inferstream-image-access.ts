import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

/**
 * InferStream API Key 管理（2026-11-17 起图片、视频各用一把，可以是同一把）。
 * 令牌只存在当前浏览器（按画布用户分开），请求经画布同源的 /inferstream/v1 转给网关。
 * 可以手填，也可以从 InferStream 账号里导入自己已建的 Key（网关 /api/canvas/keys，只对画布源开放）。
 */

export type InferStreamCapability = "image" | "video";

export const inferStreamImageModel = "gpt-image-2";
export const inferStreamProxy = "/inferstream/v1";
export const inferStreamImageProxy = inferStreamProxy;
export const inferStreamAccountOrigin = "https://www.inferstream.cn";

/** 画布能驱动的 InferStream 视频模型及参数范围（网关模型库里的说明：默认 5 秒，4–15 秒，480p/720p）。 */
export const inferStreamVideoModels: Record<string, { seconds: { min: number; max: number; default: number }; resolutions: string[]; ratios: string[] }> = {
    "seedance-2.0-mini": { seconds: { min: 4, max: 15, default: 5 }, resolutions: ["480", "720"], ratios: ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] },
};
export const inferStreamDefaultVideoModel = "seedance-2.0-mini";

const capabilityLabel: Record<InferStreamCapability, string> = { image: "生图", video: "视频" };

export function missingInferStreamToken(capability: InferStreamCapability) {
    return `请在画布设置中选择${capabilityLabel[capability]}用的 InferStream API Key。`;
}
export const missingInferStreamImageToken = missingInferStreamToken("image");

export function inferStreamEnabled() {
    return useConfigStore.getState().publicSettings?.auth?.inferStreamLogin === true;
}
export const inferStreamImageEnabled = inferStreamEnabled;
export const inferStreamVideoEnabled = inferStreamEnabled;

export function isInferStreamVideoModel(model: string) {
    return Object.hasOwn(inferStreamVideoModels, model);
}

function legacyImageKey(userId: string) {
    return `inferstream-image-api-token:${userId}`;
}
function storageKey(capability: InferStreamCapability, userId: string) {
    return capability === "image" ? legacyImageKey(userId) : `inferstream-${capability}-api-token:${userId}`;
}
function labelKey(capability: InferStreamCapability, userId: string) {
    return `inferstream-${capability}-api-token-label:${userId}`;
}

function read(key: string) {
    try {
        return localStorage.getItem(key) ?? "";
    } catch {
        return "";
    }
}
function write(key: string, value: string) {
    try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
    } catch {
        // 存储被禁用时只在本次会话里用不上令牌，下次再填。
    }
}

export function inferStreamToken(capability: InferStreamCapability, userId = useUserStore.getState().user?.id) {
    if (!userId || typeof window === "undefined") return "";
    const key = storageKey(capability, userId);
    const stored = read(key);
    if (stored || capability !== "image") return stored;
    // 早期版本把生图令牌放在 sessionStorage
    let sessionToken = "";
    try {
        sessionToken = sessionStorage.getItem(key) ?? "";
        sessionStorage.removeItem(key);
    } catch {
        sessionToken = "";
    }
    if (sessionToken) write(key, sessionToken);
    return sessionToken;
}

/** 令牌的显示名：导入时是 Key 名称，手填时是末四位。 */
export function inferStreamTokenLabel(capability: InferStreamCapability, userId = useUserStore.getState().user?.id) {
    if (!userId || typeof window === "undefined") return "";
    const token = inferStreamToken(capability, userId);
    if (!token) return "";
    return read(labelKey(capability, userId)) || `sk-…${token.slice(-4)}`;
}

/** 生图、视频 Key 变了（导入、粘贴、断开、退出）时在 window 上发的事件，顶栏钥匙按钮据此刷新。 */
export const INFERSTREAM_TOKENS_EVENT = "inferstream-tokens-changed";

export function saveInferStreamToken(capability: InferStreamCapability, userId: string, token: string, label = "") {
    write(storageKey(capability, userId), token);
    write(labelKey(capability, userId), token ? label : "");
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") window.dispatchEvent(new Event(INFERSTREAM_TOKENS_EVENT));
}

/** 顶栏钥匙按钮：两把都有「Key 已就绪」，缺一把「Key 未选全」，都没有「未连接 Key」；提示里写各用哪一把。 */
export function inferStreamKeyStatus(imageLabel: string, videoLabel: string) {
    const label = imageLabel && videoLabel ? "Key 已就绪" : imageLabel || videoLabel ? "Key 未选全" : "未连接 Key";
    const tooltip = `生图：${imageLabel || "未选"} · 视频：${videoLabel || "未选"}（只保存在本浏览器）`;
    return { label, tooltip };
}

export function clearInferStreamTokens(userId: string) {
    for (const capability of ["image", "video"] as const) saveInferStreamToken(capability, userId, "");
}

export function inferStreamImageToken(userId = useUserStore.getState().user?.id) {
    return inferStreamToken("image", userId);
}
export function saveInferStreamImageToken(userId: string, token: string) {
    saveInferStreamToken("image", userId, token);
}

/** 用 /v1/models 验证令牌能调用这项能力：生图要有 gpt-image-2，视频要有任一画布支持的视频模型。返回可用的视频模型。 */
export async function verifyInferStreamToken(capability: InferStreamCapability, token: string) {
    const response = await fetch(`${inferStreamProxy}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("InferStream Key 验证失败，请检查 Key 和权限。");
    const models = ((await response.json()) as { data?: { id: string }[] }).data?.map(({ id }) => id) ?? [];
    if (capability === "image") {
        if (!models.includes(inferStreamImageModel)) throw new Error(`这个 Key 暂时无法调用 ${inferStreamImageModel}。`);
        return [inferStreamImageModel];
    }
    const video = models.filter(isInferStreamVideoModel);
    if (!video.length) throw new Error(`这个 Key 暂时无法调用视频模型（${Object.keys(inferStreamVideoModels).join("、")}）。`);
    return video;
}

export function verifyInferStreamImageToken(token: string) {
    return verifyInferStreamToken("image", token);
}

export type InferStreamAccountKey = {
    id: number;
    name: string;
    key_hint: string;
    org_id: number;
    unlimited_quota: boolean;
    remain_quota: number;
    /** 空数组表示不限模型 */
    models: string[];
};

async function accountRequest<T>(path: string): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${inferStreamAccountOrigin}/api/canvas/keys${path}`, {
            credentials: "include",
            cache: "no-store",
            headers: { "X-InferStream-Canvas": "1" },
            signal: AbortSignal.timeout(15000),
        });
    } catch {
        throw new Error("连不上 InferStream 账号，请稍后重试或手动粘贴 Key。");
    }
    if (response.status === 401 || response.status === 403) throw new Error("请先在 www.inferstream.cn 登录，再导入 Key。");
    const payload = (await response.json().catch(() => null)) as { success?: boolean; message?: string; data?: T } | null;
    if (!response.ok || !payload?.success || payload.data === undefined) throw new Error(payload?.message || "读取 InferStream Key 失败。");
    return payload.data;
}

/** 列出当前 InferStream 账号下自己可用的 Key（不含完整密钥）。 */
export function listInferStreamAccountKeys() {
    return accountRequest<InferStreamAccountKey[]>("");
}

/** 取回一把 Key 的完整密钥（只在用户选中时调用）。 */
export async function revealInferStreamAccountKey(id: number) {
    const data = await accountRequest<{ key: string; name: string }>(`/${id}`);
    if (!data.key) throw new Error("读取 InferStream Key 失败。");
    return data;
}

/** 这把 Key 的模型限制是否允许这项能力。 */
export function accountKeyAllows(key: InferStreamAccountKey, capability: InferStreamCapability) {
    if (!key.models.length) return true;
    return capability === "image" ? key.models.includes(inferStreamImageModel) : key.models.some(isInferStreamVideoModel);
}

/** 导入：取回完整密钥、验证能力、存进这项能力的位置。 */
export async function importInferStreamAccountKey(capability: InferStreamCapability, userId: string, key: InferStreamAccountKey) {
    const { key: token } = await revealInferStreamAccountKey(key.id);
    await verifyInferStreamToken(capability, token);
    saveInferStreamToken(capability, userId, token, key.name);
}

const autoImportAttempted = new Set<string>();

/**
 * 登录后自动导入：生图、视频哪项还没有 Key，就从账号里挑最新一把允许这项能力的 Key（验证通过才存）。
 * 每个用户每次打开页面只试一次；读不到账号 Key、没有合适的 Key 都静默跳过，用户仍可在设置里手选。
 */
export async function autoImportInferStreamKeys(userId: string) {
    if (autoImportAttempted.has(userId)) return;
    autoImportAttempted.add(userId);
    const missing = (["image", "video"] as const).filter((capability) => !inferStreamToken(capability, userId));
    if (!missing.length) return;
    let keys: InferStreamAccountKey[];
    try {
        keys = await listInferStreamAccountKeys();
    } catch {
        return;
    }
    for (const capability of missing) {
        for (const key of keys.filter((item) => accountKeyAllows(item, capability))) {
            if (useUserStore.getState().user?.id !== userId) return;
            try {
                await importInferStreamAccountKey(capability, userId, key);
                break;
            } catch {
                // 这把 Key 调不了这项能力（例如分组里没有这个模型），试下一把
            }
        }
    }
}
