import { ApiError, apiGet, apiPost } from "@/services/api/request";

export const AUTH_TOKEN_KEY = "infinite-canvas-auth-token-v1";

export type UserRole = "guest" | "user" | "admin";

export type AuthUser = {
    id: string;
    username: string;
    displayName: string;
    avatarUrl: string;
    role: UserRole;
    credits: number;
    createdAt: string;
    updatedAt: string;
    /** 只有用 openai.fit 登录建的画布账号才有：关联的 openai.fit 用户 ID（fit 那边换了人时画布账号跟着换）。 */
    fitUserId?: number;
};

export type AuthSession = {
    token: string;
    user: AuthUser;
};

export type AuthPayload = {
    username: string;
    password: string;
};

export async function login(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/login", payload);
}

/** 用 openai.fit 登录：只把 openai.fit 桥接页给的一次性 code、state 和 PKCE verifier 发给画布后端，令牌不发。 */
export type FitLoginPayload = {
    code: string;
    codeVerifier: string;
    state: string;
};

export async function loginWithInferStream(payload: FitLoginPayload) {
    return apiPost<AuthSession>("/api/auth/inferstream/login", payload);
}

export async function loginWithFit(payload: FitLoginPayload) {
    return apiPost<AuthSession>("/api/auth/fit/login", payload);
}

// 管理员账号只能走后台登录；前台登录接口对管理员回 403「请从后台登录」。
export const ADMIN_LOGIN_REQUIRED = "请从后台登录";

export async function adminLogin(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/admin/login", payload);
}

export function isAdminRedirect(redirect: string) {
    return /^\/admin(?:[/?#]|$)/.test(redirect);
}

// 登录页选入口：要回 /admin 的直接走后台登录；前台登录回 403「请从后台登录」时，用同一组账号密码改走后台登录。
export async function loginForRedirect<T>(redirect: string, asUser: () => Promise<T>, asAdmin: () => Promise<T>) {
    if (isAdminRedirect(redirect)) return asAdmin();
    try {
        return await asUser();
    } catch (error) {
        if (error instanceof ApiError && error.status === 403 && error.message === ADMIN_LOGIN_REQUIRED) return asAdmin();
        throw error;
    }
}

export async function register(payload: AuthPayload) {
    return apiPost<AuthSession>("/api/auth/register", payload);
}

export async function fetchCurrentUser(token?: string) {
    return apiGet<AuthUser>("/api/auth/me", undefined, token);
}
