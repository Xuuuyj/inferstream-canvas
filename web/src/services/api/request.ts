import axios from "axios";

export type ApiParams = Record<string, string | string[] | number | number[] | undefined>;

type ApiResponse<T> = {
    code: number;
    data: T;
    msg: string;
};

/** 接口失败：status 是 HTTP 状态码（连不上为 0），retryAfter 是响应头 Retry-After 的原文。 */
export class ApiError extends Error {
    status: number;
    retryAfter: string;

    constructor(message: string, status: number, retryAfter = "") {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.retryAfter = retryAfter;
    }
}

/**
 * 保存类请求失败后过多久重试（毫秒）：429 按 Retry-After（秒数或 HTTP 日期）等，没有或读不出时和连不上、5xx 一样等 backoffMs；
 * 其余 4xx 和非接口错误重试也没用，返回 null。
 */
export function saveRetryDelayMs(error: unknown, backoffMs: number, now = Date.now()): number | null {
    if (!(error instanceof ApiError) || (error.status && error.status !== 429 && error.status < 500)) return null;
    const retryAfter = error.status === 429 ? error.retryAfter.trim() : "";
    if (!retryAfter) return backoffMs;
    const waitMs = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
    return Number.isNaN(waitMs) ? backoffMs : Math.max(1000, waitMs);
}

export function compactApiParams(params: ApiParams) {
    return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== "" && value !== undefined && (!Array.isArray(value) || value.length > 0))) as ApiParams;
}

export function serializeApiParams(params?: ApiParams) {
    const queryParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        if (value === undefined) continue;
        if (Array.isArray(value)) value.forEach((item) => queryParams.append(key, String(item)));
        else queryParams.set(key, String(value));
    }
    return queryParams;
}

export async function apiGet<T>(url: string, params?: ApiParams, token?: string) {
    return apiRequest<T>({
        url,
        method: "GET",
        params: params || undefined,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

export async function apiPost<T>(url: string, body?: unknown, token?: string) {
    return apiRequest<T>({
        url,
        method: "POST",
        data: body ?? {},
        headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
    });
}

export async function apiDelete<T>(url: string, token?: string) {
    return apiRequest<T>({
        url,
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    });
}

async function apiRequest<T>(config: { url: string; method: "GET" | "POST" | "DELETE"; params?: ApiParams; data?: unknown; headers?: Record<string, string> }) {
    let response;
    try {
        response = await axios.request<ApiResponse<T>>({
            url: config.url,
            method: config.method,
            params: config.params,
            paramsSerializer: { serialize: (params) => serializeApiParams(params as ApiParams).toString() },
            data: config.data,
            headers: config.headers,
            validateStatus: () => true,
        });
    } catch {
        throw new ApiError("接口连接失败，请确认后端服务已启动", 0);
    }

    const retryAfter = String(response.headers?.["retry-after"] ?? "");
    const result = response.data;
    if (!result || typeof result !== "object") {
        throw new ApiError(response.status === 404 ? "接口不存在，请确认后端服务已启动" : "接口返回异常，请稍后重试", response.status, retryAfter);
    }

    const payload = result as ApiResponse<T>;
    if (response.status < 200 || response.status >= 300 || payload.code !== 0) {
        throw new ApiError(payload.msg || "请求失败", response.status, retryAfter);
    }

    return payload.data;
}
