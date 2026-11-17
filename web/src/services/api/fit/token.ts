import type { FitTokenModel } from "@/lib/fit-models";
import { fitFetch } from "./transport";

export type FitTokenInfo = { name: string; expiresAt: number; unlimitedQuota: boolean; totalAvailable: number };

async function fitGet(path: string, apiKey: string, fallback: string) {
    let response: Response;
    try {
        response = await fitFetch(path, { headers: { Authorization: `Bearer ${apiKey}` } });
    } catch {
        throw new Error("连接原模型服务失败，请检查网络后重试");
    }
    const payload = (await response.json().catch(() => null)) as { success?: boolean; message?: string; error?: { message?: string }; data?: unknown } | null;
    if (!response.ok || payload?.success === false) throw new Error(payload?.error?.message || payload?.message || `${fallback}：${response.status}`);
    return payload?.data;
}

/** 用令牌请求 GET /v1/models：能调通就说明令牌有效，同时拿到它能调的模型。 */
export async function validateFitToken(apiKey: string): Promise<FitTokenModel[]> {
    const data = await fitGet("/v1/models", apiKey, "原模型服务令牌验证失败");
    if (!Array.isArray(data)) throw new Error("原模型服务返回的模型列表格式不对");
    return data.filter((item): item is FitTokenModel => Boolean(item) && typeof item.id === "string");
}

/** GET /api/usage/token/：令牌名、到期时间（秒，0 表示永不过期）和余额。 */
export async function fetchFitTokenInfo(apiKey: string): Promise<FitTokenInfo> {
    const data = (await fitGet("/api/usage/token/", apiKey, "读取原模型服务令牌信息失败")) as { name?: string; expires_at?: number; unlimited_quota?: boolean; total_available?: number } | undefined;
    return { name: data?.name || "", expiresAt: Number(data?.expires_at) || 0, unlimitedQuota: data?.unlimited_quota === true, totalAvailable: Number(data?.total_available) || 0 };
}
