import { isFitApiKey } from "@/lib/fit-config";
import { FIT_ORIGIN } from "@/lib/model-channel";
import type { FitKind } from "@/stores/use-config-store";

/**
 * 画布和 openai.fit 桥接页（https://openai.fit/canvas/bridge，隐藏 iframe）之间的消息协议，和 fit 的 controller/canvas_bridge.js 逐字一致：
 * 画布 → 桥：hello（可带 login:{state, codeChallenge}）、ping（只问 fit 还登录着没，不发请求）、keys{tokenIds}、
 * create{tokenKind, group}（令牌类型字段叫 tokenKind，kind 已经是消息类型 create；令牌名由桥接页生成）；
 * 桥 → 画布：ready、status、presence{session}、keys、created{token, key?, keyError?}（令牌建好了但取 key 失败时不带 key、带 keyError）、error。
 * 所有消息都带 channel 和 rid。桥接页每条消息 18 秒内一定回一次（画布等 20 秒）。
 * 画布只收 origin 是 https://openai.fit、source 是这个 iframe 的消息，其余一律丢弃；发消息时 targetOrigin 写死 https://openai.fit。
 */
export const FIT_BRIDGE_URL = `${FIT_ORIGIN}/canvas/bridge`;
export const FIT_BRIDGE_CHANNEL = "fit-canvas-bridge/1";
export const FIT_SIGN_IN_URL = `${FIT_ORIGIN}/sign-in`;
/** 画布里主动「退出登录」后记下的「不要自动连接 openai.fit」标记，只有用户再点「用 openai.fit 登录」才清掉。 */
export const FIT_AUTO_LOGIN_OFF_KEY = "infinite-canvas:fit-auto-login-off";
/** 画布这边每个请求等多久没回应就当网络错误；桥接页加载后多久没发 ready 就当连不上。 */
export const FIT_BRIDGE_REQUEST_TIMEOUT_MS = 20_000;
export const FIT_BRIDGE_READY_TIMEOUT_MS = 10_000;
/** 两次 hello 至少隔多久（桥接页自己也限频）。 */
export const FIT_BRIDGE_HELLO_GAP_MS = 3_000;
/** 令牌是桥接页取的：多久用一次 hello 核对 fit 账号有没有换人（平时打开页面只 ping，不花 fit 的限频）。 */
export const FIT_ACCOUNT_RECHECK_MS = 12 * 60 * 60 * 1000;
/** sessionStorage：这个标签页已经按 fit 的令牌列表挑过一轮，还有某一类没有能用的令牌；之后打开页面不为它再挂桥接页（设置里照常能选、能新建）。 */
export const FIT_KEYS_CHECKED_KEY = "infinite-canvas:fit-keys-checked";
/** localStorage：本机画布项目上次同步到了哪个账号（fit:<fit 用户 id> 或 user:<画布用户 id>）。 */
export const CANVAS_PROJECTS_OWNER_KEY = "infinite-canvas:projects-owner";

export type FitBridgeUser = { id: number; displayName: string; group: string };
export type FitBridgeGroup = { name: string; desc: string; ratio: number | null };
/** 桥接页列出的令牌，不含密钥。 */
export type FitBridgeToken = { id: number; name: string; group: string; status: number; expired_time: number; remain_quota: number; unlimited_quota: boolean; auto_groups: string[] };
export type FitBridgeError = "not_logged_in" | "rate_limited" | "invalid" | "network" | "server" | "token_limit";
export type FitBridgeCodeError = "disabled" | "rate_limited" | "server";
export type FitBridgeStatus =
    | { kind: "status"; rid: string; loggedIn: false }
    | { kind: "status"; rid: string; loggedIn: true; user: FitBridgeUser; groups: FitBridgeGroup[]; tokens: FitBridgeToken[]; tokensTotal: number; code?: string; codeExpiresIn?: number; codeError?: FitBridgeCodeError };
export type FitBridgeIncoming =
    | { kind: "ready"; rid: string }
    | FitBridgeStatus
    | { kind: "keys"; rid: string; keys: Record<number, string> }
    /** 令牌建好了但取密钥失败时没有 key、带 keyError（令牌已经在 fit 上了，画布之后再取）。 */
    | { kind: "created"; rid: string; token: FitBridgeToken; key?: string; keyError?: FitBridgeError }
    | { kind: "error"; rid: string; error: FitBridgeError; message?: string }
    /** ping 的回答：fit 的登录提示 cookie 在不在。 */
    | { kind: "presence"; rid: string; session: boolean };
export type FitBridgeLogin = { state: string; codeChallenge: string };

const ridPattern = /^[A-Za-z0-9_-]{8,64}$/;
const codePattern = /^[A-Za-z0-9_-]{43}$/;
const bridgeErrors = new Set<string>(["not_logged_in", "rate_limited", "invalid", "network", "server", "token_limit"]);
const codeErrors = new Set<string>(["disabled", "rate_limited", "server"]);
const MAX_TOKENS = 100;

type Record_ = Record<string, unknown>;
const isObject = (value: unknown): value is Record_ => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isPositiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function parseToken(value: unknown): FitBridgeToken | null {
    if (!isObject(value)) return null;
    const { id, name, group, status, expired_time, remain_quota, unlimited_quota, auto_groups } = value;
    if (!isPositiveInt(id) || typeof name !== "string" || typeof group !== "string" || !isNumber(status) || !isNumber(expired_time) || !isNumber(remain_quota) || typeof unlimited_quota !== "boolean") return null;
    const autoGroups = Array.isArray(auto_groups) ? auto_groups.filter((item): item is string => typeof item === "string") : [];
    return { id, name: name.slice(0, 64), group, status, expired_time, remain_quota, unlimited_quota, auto_groups: autoGroups };
}

function parseGroup(value: unknown): FitBridgeGroup | null {
    if (!isObject(value) || typeof value.name !== "string" || !value.name) return null;
    return { name: value.name, desc: typeof value.desc === "string" && value.desc ? value.desc : value.name, ratio: isNumber(value.ratio) ? value.ratio : null };
}

function parseStatus(rid: string, data: Record_): FitBridgeStatus | null {
    if (data.loggedIn === false) return { kind: "status", rid, loggedIn: false };
    if (data.loggedIn !== true || !isObject(data.user) || !isPositiveInt(data.user.id)) return null;
    if (!Array.isArray(data.groups) || !Array.isArray(data.tokens) || data.tokens.length > MAX_TOKENS) return null;
    const tokens = data.tokens.map(parseToken);
    if (tokens.some((token) => !token)) return null;
    const user = data.user;
    const displayName = (typeof user.displayName === "string" ? user.displayName : "").slice(0, 64);
    const status: FitBridgeStatus = {
        kind: "status",
        rid,
        loggedIn: true,
        user: { id: user.id as number, displayName, group: typeof user.group === "string" ? user.group : "" },
        groups: data.groups.map(parseGroup).filter((group): group is FitBridgeGroup => Boolean(group)),
        tokens: tokens as FitBridgeToken[],
        tokensTotal: isNumber(data.tokensTotal) && data.tokensTotal >= 0 ? data.tokensTotal : tokens.length,
    };
    if (data.code !== undefined) {
        if (typeof data.code !== "string" || !codePattern.test(data.code)) return null;
        status.code = data.code;
        status.codeExpiresIn = isNumber(data.codeExpiresIn) ? data.codeExpiresIn : 60;
    }
    if (typeof data.codeError === "string" && codeErrors.has(data.codeError)) status.codeError = data.codeError as FitBridgeCodeError;
    return status;
}

/**
 * 校验桥接页发来的消息：origin 必须是 https://openai.fit、source 必须是画布自己放的那个 iframe、channel 和 rid 对得上，字段类型都对；
 * 不合格返回 null（调用方静默丢弃）。keys 里格式不对的密钥直接丢掉（画布按「令牌已被删除」处理）。
 */
export function parseBridgeMessage(event: { origin: string; source: unknown; data: unknown }, frame: unknown): FitBridgeIncoming | null {
    if (event.origin !== FIT_ORIGIN || !frame || event.source !== frame) return null;
    const data = event.data;
    if (!isObject(data) || data.channel !== FIT_BRIDGE_CHANNEL || typeof data.rid !== "string" || !ridPattern.test(data.rid)) return null;
    const rid = data.rid;
    switch (data.kind) {
        case "ready":
            return { kind: "ready", rid };
        case "status":
            return parseStatus(rid, data);
        case "keys": {
            if (!isObject(data.keys)) return null;
            const keys: Record<number, string> = {};
            for (const [id, key] of Object.entries(data.keys)) if (/^[1-9]\d{0,15}$/.test(id) && isFitApiKey(key)) keys[Number(id)] = key;
            return { kind: "keys", rid, keys };
        }
        case "created": {
            const token = parseToken(data.token);
            if (!token) return null;
            if (isFitApiKey(data.key)) return { kind: "created", rid, token, key: data.key };
            return { kind: "created", rid, token, keyError: typeof data.keyError === "string" && bridgeErrors.has(data.keyError) ? (data.keyError as FitBridgeError) : "server" };
        }
        case "presence":
            return typeof data.session === "boolean" ? { kind: "presence", rid, session: data.session } : null;
        case "error":
            if (typeof data.error !== "string" || !bridgeErrors.has(data.error)) return null;
            return { kind: "error", rid, error: data.error as FitBridgeError, ...(data.error === "token_limit" && typeof data.message === "string" ? { message: data.message.slice(0, 200) } : {}) };
        default:
            return null;
    }
}

export function bridgeHello(rid: string, login?: FitBridgeLogin) {
    return { channel: FIT_BRIDGE_CHANNEL, kind: "hello", rid, ...(login ? { login } : {}) };
}

export function bridgePing(rid: string) {
    return { channel: FIT_BRIDGE_CHANNEL, kind: "ping", rid };
}

export function bridgeKeys(rid: string, tokenIds: number[]) {
    return { channel: FIT_BRIDGE_CHANNEL, kind: "keys", rid, tokenIds };
}

/** 新建令牌：令牌名由桥接页按类型生成（无限画布-视频 / 图片 / 文本），画布不传名字。 */
export function bridgeCreate(rid: string, kind: FitKind, group: string) {
    return { channel: FIT_BRIDGE_CHANNEL, kind: "create", rid, tokenKind: kind, group };
}

function base64Url(bytes: Uint8Array) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 字节随机数的 base64url（43 位），给 PKCE 的 verifier 和 state 用。 */
export function randomToken(crypto: Crypto) {
    return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 每个请求的 rid：16 字节随机数的 base64url（22 位）。 */
export function newRid(crypto: Crypto) {
    return base64Url(crypto.getRandomValues(new Uint8Array(16)));
}

export async function pkceChallenge(verifier: string, crypto: Crypto) {
    return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

type FlagStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const defaultStorage = (): FlagStorage | null => {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
};
const defaultSessionStorage = (): FlagStorage | null => {
    try {
        return globalThis.sessionStorage ?? null;
    } catch {
        return null;
    }
};
const readItem = (storage: FlagStorage | null, key: string) => {
    try {
        return storage?.getItem(key) ?? null;
    } catch {
        return null;
    }
};
const writeItem = (storage: FlagStorage | null, key: string, value: string) => {
    try {
        storage?.setItem(key, value);
    } catch {
        // 存不下就只在本页生效
    }
};

/** 「不要自动登录」标记：读写都包 try/catch（隐私窗口、禁用站点数据时存储会抛错），读不到当作没有。 */
export function readFitAutoLoginOff(storage: FlagStorage | null = defaultStorage()) {
    try {
        return storage?.getItem(FIT_AUTO_LOGIN_OFF_KEY) === "1";
    } catch {
        return false;
    }
}

export function writeFitAutoLoginOff(off: boolean, storage: FlagStorage | null = defaultStorage()) {
    try {
        if (off) storage?.setItem(FIT_AUTO_LOGIN_OFF_KEY, "1");
        else storage?.removeItem(FIT_AUTO_LOGIN_OFF_KEY);
    } catch {
        // 存不下就只在本页生效
    }
}

export function readFitKeysChecked(storage: FlagStorage | null = defaultSessionStorage()) {
    return readItem(storage, FIT_KEYS_CHECKED_KEY) === "1";
}

export function writeFitKeysChecked(storage: FlagStorage | null = defaultSessionStorage()) {
    writeItem(storage, FIT_KEYS_CHECKED_KEY, "1");
}

/** 令牌被清掉（fit 退出或换人）后要重新挑，标记作废。 */
export function clearFitKeysChecked(storage: FlagStorage | null = defaultSessionStorage()) {
    try {
        storage?.removeItem(FIT_KEYS_CHECKED_KEY);
    } catch {
        // 存储不可用时标记本来也没写进去
    }
}

export function readCanvasProjectsOwner(storage: FlagStorage | null = defaultStorage()) {
    return readItem(storage, CANVAS_PROJECTS_OWNER_KEY);
}

export function writeCanvasProjectsOwner(owner: string, storage: FlagStorage | null = defaultStorage()) {
    writeItem(storage, CANVAS_PROJECTS_OWNER_KEY, owner);
}

/** 本机画布项目同步到的账号：用 openai.fit 建的画布账号按 fit 用户记，其余按画布用户记。 */
export function canvasProjectsOwner(user: { id: string; fitUserId?: number }) {
    return user.fitUserId ? `fit:${user.fitUserId}` : `user:${user.id}`;
}

/** 静默用 openai.fit 登录画布之前：本机有画布项目、而且上次没同步到这个 fit 账号，就先问（登录后项目会同步进这个账号）。 */
export function asksBeforeProjectSync(localProjects: number, owner: string | null, fitUserId: number) {
    return localProjects > 0 && owner !== `fit:${fitUserId}`;
}

/** openai.fit 换了人：from 是原来令牌或画布账号的名字；keys 表示原来的令牌已从本浏览器清掉；canvas 表示画布账号也要跟着换。 */
export type AccountSwitch = { from: string; to: FitBridgeUser; keys: boolean; canvas: boolean };

export function accountSwitchText({ from, to, keys, canvas }: AccountSwitch) {
    const name = from || "原来的账号";
    const owned = keys && canvas ? "令牌和画布账号" : keys ? "令牌" : "画布账号";
    const dropped = keys ? `为安全起见，「${name}」的令牌已从本浏览器清掉（「${name}」还没生成完的视频将无法取回）。` : "";
    const after = canvas ? "改用后画布账号也换成它的，本机的画布项目会同步过去。" : "";
    return `openai.fit 现在登录的是「${to.displayName}」，画布里原来用的是「${name}」的${owned}。${dropped}要改用「${to.displayName}」吗？${after}如果你没有登录过「${to.displayName}」，请选「不用」，再到 openai.fit 退出、重新登录自己的账号。`;
}

export type BridgeMountInput = {
    pathname: string;
    autoLoginOff: boolean;
    fitLogin: boolean;
    userReady: boolean;
    userToken: string;
    keysComplete: boolean;
    /** 这个标签页已经挑过一轮令牌、还有某一类没有能用的（见 FIT_KEYS_CHECKED_KEY）。 */
    keysChecked: boolean;
    configOpen: boolean;
    pendingSignIn: boolean;
    /** 令牌是桥接页取的，本次打开页面还没核对 fit 还登录着没。 */
    presencePending: boolean;
    /** 上次用 hello 核对 fit 账号已超过 FIT_ACCOUNT_RECHECK_MS。 */
    accountStale: boolean;
};

/** 画布登录要不要靠 openai.fit：开了 fit 登录、画布没登录（登录页不等 /auth/me，那里本来就不 hydrate）。 */
export function needsCanvasLogin({ pathname, fitLogin, userReady, userToken }: Pick<BridgeMountInput, "pathname" | "fitLogin" | "userReady" | "userToken">) {
    return fitLogin && !userToken && (userReady || pathname === "/login");
}

/** 有正事要 hello：用户没点过「退出登录」（不要自动登录），并且画布要登录、三把令牌没齐（这个标签页还没挑过）、设置弹窗开着、或刚去 openai.fit 登录还没回来。 */
function bridgeWantsHello(input: BridgeMountInput) {
    return !input.autoLoginOff && (needsCanvasLogin(input) || (!input.keysComplete && !input.keysChecked) || input.configOpen || input.pendingSignIn);
}

/**
 * 什么时候在页面里放桥接页：不在后台，并且有正事要 hello，或令牌是桥接页取的、本次打开页面还没核对 fit 还登录着没（退出过画布也核对：fit 退出了就清掉这些令牌）。
 * 都办完、弹窗也关了就卸载。
 */
export function shouldMountBridge(input: BridgeMountInput) {
    if (input.pathname.startsWith("/admin")) return false;
    return bridgeWantsHello(input) || input.presencePending;
}

/** 桥接页 ready 之后先发什么：有正事，或令牌的 fit 账号 12 小时没核对过（且没关自动连接）就 hello；只为核对 fit 还登录着没就 ping（不发 fit 请求）。 */
export function bridgeOpening(input: BridgeMountInput): "hello" | "ping" {
    return bridgeWantsHello(input) || (input.presencePending && input.accountStale && !input.autoLoginOff) ? "hello" : "ping";
}
