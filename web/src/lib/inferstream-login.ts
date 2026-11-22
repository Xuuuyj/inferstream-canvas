const authorizationURL = "https://www.inferstream.cn/api/canvas/authorize";
const attemptKey = "inferstream-canvas-sso-attempt";
const autoLoginOffKey = "inferstream-canvas-sso-off";

export function disableInferStreamAutoLogin() {
    try {
        localStorage.setItem(autoLoginOffKey, "1");
    } catch {
        // A blocked storage API already prevents the authorization flow.
    }
}

const pendingKey = "inferstream-canvas-sso-pending";

export function safeCanvasReturn(path: string) {
    if (!path.startsWith("/") || /^[/][/\\]/.test(path) || /[\x00-\x20]/.test(path)) return "/";
    const parsed = new URL(path, window.location.origin);
    if (parsed.origin !== window.location.origin || /^\/(admin|login|auth)(?:\/|$)/.test(parsed.pathname)) return "/";
    return parsed.pathname + parsed.search + parsed.hash;
}

function base64url(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startInferStreamLogin(redirect: string, silent = false) {
    if (silent && (sessionStorage.getItem(attemptKey) || localStorage.getItem(autoLoginOffKey))) return;
    sessionStorage.setItem(attemptKey, "1");
    if (silent) {
        const response = await fetch(authorizationURL.replace("/authorize", "/session"), { credentials: "include", cache: "no-store" });
        if (response.status !== 204) return;
    } else {
        localStorage.removeItem(autoLoginOffKey);
    }
    const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    sessionStorage.setItem(pendingKey, JSON.stringify({ state, verifier, redirect: safeCanvasReturn(redirect), silent }));
    const target = new URL(authorizationURL);
    target.search = new URLSearchParams({
        state,
        code_challenge: base64url(new Uint8Array(hash)),
        ...(silent ? { prompt: "none" } : {}),
    }).toString();
    if (silent) window.location.replace(target);
    else window.location.assign(target);
}

export function consumeInferStreamLogin(state: string) {
    const raw = sessionStorage.getItem(pendingKey);
    if (!raw) return null;
    const request = JSON.parse(raw) as { state: string; verifier: string; redirect: string; silent?: boolean };
    if (request.state !== state) return null;
    sessionStorage.removeItem(pendingKey);
    return request;
}
