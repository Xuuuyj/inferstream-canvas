import { FIT_ORIGIN } from "@/lib/model-channel";

export function getFitOrigin() {
    return FIT_ORIGIN;
}

/** 浏览器直连 openai.fit：以 / 开头的路径拼上 FIT_ORIGIN，并且永远不带 Cookie。 */
export function fitFetch(input: RequestInfo | URL, init?: RequestInit) {
    const target = typeof input === "string" && input.startsWith("/") ? `${FIT_ORIGIN}${input}` : input;
    return fetch(target, { ...init, credentials: "omit" });
}

/** 只有目标地址的源站正好是 FIT_ORIGIN 时才带 openai.fit 令牌；相对地址（画布服务器）和别的域名一律不带。 */
export function fitAuthHeaders(target: string, apiKey: string): Record<string, string> {
    try {
        return apiKey.trim() && new URL(target).origin === FIT_ORIGIN ? { Authorization: `Bearer ${apiKey}` } : {};
    } catch {
        return {};
    }
}
