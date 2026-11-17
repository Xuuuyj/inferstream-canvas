import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

export const inferStreamImageModel = "gpt-image-2";
export const inferStreamImageProxy = "/inferstream/v1";
export const missingInferStreamImageToken = "请在画布设置中填写 InferStream API Token。";

export function inferStreamImageEnabled() {
    return useConfigStore.getState().publicSettings?.auth?.inferStreamLogin === true;
}

function tokenStorageKey(userId: string) {
    return `inferstream-image-api-token:${userId}`;
}

export function inferStreamImageToken(userId = useUserStore.getState().user?.id) {
    if (!userId || typeof window === "undefined") return "";
    const key = tokenStorageKey(userId);
    const stored = localStorage.getItem(key);
    if (stored) return stored;
    const sessionToken = sessionStorage.getItem(key) ?? "";
    if (sessionToken) saveInferStreamImageToken(userId, sessionToken);
    return sessionToken;
}

export function saveInferStreamImageToken(userId: string, token: string) {
    const key = tokenStorageKey(userId);
    if (token) localStorage.setItem(key, token);
    else localStorage.removeItem(key);
    sessionStorage.removeItem(key);
}

export async function verifyInferStreamImageToken(token: string) {
    const response = await fetch(`${inferStreamImageProxy}/models`, {
        headers: { Authorization: `Bearer ${token}` },
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("InferStream Token 验证失败，请检查令牌和权限。");
    const models = (await response.json()) as { data?: { id: string }[] };
    if (!models.data?.some(({ id }) => id === inferStreamImageModel)) {
        throw new Error(`这个令牌暂时无法调用 ${inferStreamImageModel}。`);
    }
}
