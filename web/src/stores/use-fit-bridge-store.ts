"use client";

import { create } from "zustand";

import { localCanvasProjectCount } from "@/lib/canvas-local-projects";
import {
    FIT_BRIDGE_HELLO_GAP_MS,
    FIT_BRIDGE_REQUEST_TIMEOUT_MS,
    asksBeforeProjectSync,
    bridgeCreate,
    bridgeHello,
    bridgeKeys,
    bridgePing,
    clearFitKeysChecked,
    needsCanvasLogin,
    newRid,
    pkceChallenge,
    randomToken,
    readCanvasProjectsOwner,
    readFitAutoLoginOff,
    readFitKeysChecked,
    writeFitAutoLoginOff,
    writeFitKeysChecked,
    type AccountSwitch,
    type FitBridgeError,
    type FitBridgeGroup,
    type FitBridgeIncoming,
    type FitBridgeToken,
    type FitBridgeUser,
} from "@/lib/fit-bridge";
import { FIT_KIND_LABELS, FIT_KINDS, normalizeFitApiKey } from "@/lib/fit-config";
import { groupKindModels, pickToken, planFitKeySlots, replacedSlotText, type GroupKindModels, type KeySelectContext } from "@/lib/fit-key-select";
import { fetchFitCatalog } from "@/services/api/fit/catalog";
import { useConfigStore, type FitKeySlot, type FitKind } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

/**
 * openai.fit 桥接页（隐藏 iframe，见 components/layout/fit-bridge.tsx）的状态和请求，不持久化。
 * 令牌密钥只在内存的 keyCache（避免同一把令牌重复取）和配置 store 的槽位里，永不上传。
 */
export type FitBridgeConnection = "idle" | "connecting" | "ready" | "unavailable";
type Notify = (type: "success" | "info" | "warning" | "error", text: string) => void;
/** 静默登录画布之前要用户点头：本机有没同步到这个 fit 账号的画布项目，登录后会同步进去。 */
export type ProjectConsent = { fitUser: FitBridgeUser; projects: number };

export class FitBridgeRequestError extends Error {
    code: FitBridgeError;

    constructor(code: FitBridgeError, fitMessage?: string) {
        super(bridgeErrorText(code, fitMessage));
        this.name = "FitBridgeRequestError";
        this.code = code;
    }
}

export function bridgeErrorText(code: FitBridgeError, fitMessage?: string) {
    switch (code) {
        case "rate_limited":
            return "openai.fit 操作太频繁（同一网络 20 分钟内有次数限制），请稍后再试";
        case "not_logged_in":
            return "openai.fit 未登录";
        case "token_limit":
            return `令牌数量已达上限（${fitMessage || "openai.fit 的令牌数量上限"}），请到 openai.fit 令牌管理删掉不用的`;
        case "invalid":
            return "请求无效，请刷新页面后重试";
        case "network":
            return "暂时连不上 openai.fit";
        default:
            return "openai.fit 暂时出错，请稍后再试";
    }
}

const FIT_SIGNED_OUT_TEXT = "openai.fit 已退出登录，本浏览器里自动取的令牌已清掉（手动填写的令牌保留）";

type FitBridgeStore = {
    connection: FitBridgeConnection;
    /** null：还没问过；false：openai.fit 未登录。 */
    fitLoggedIn: boolean | null;
    fitUser: FitBridgeUser | null;
    groups: FitBridgeGroup[];
    tokens: FitBridgeToken[];
    tokensTotal: number;
    /** 每个分组里的视频、图片、文本、语音模型（按公开目录算）；目录拿不到时为 null。 */
    byGroup: GroupKindModels | null;
    statusAt: number;
    /** 现在这个桥接页已经回过 status（重新挂载后、回 status 之前令牌列表还是旧的，不能拿来换令牌）。 */
    statusFresh: boolean;
    /** 本次打开页面已经核对过 fit 还登录着没（ping 或 hello）。 */
    presenceChecked: boolean;
    /** 这个标签页已经挑过一轮令牌、还有某一类没有能用的（sessionStorage）。 */
    keysChecked: boolean;
    lastError: string;
    loginState: "idle" | "pending" | "failed";
    loginError: string;
    /** 最近一次用 openai.fit 自动登录画布成功的时间（登录页据此跳回原页面）。 */
    signedInAt: number;
    /** openai.fit 没开画布账号自动登录（CANVAS_CONNECT_SECRET 没配），令牌照常能取。 */
    codeDisabled: boolean;
    pendingSignIn: boolean;
    autoLoginOff: boolean;
    frameKey: number;
    /** 429 之后「重试」按钮这个时间之前不可点。 */
    retryBlockedUntil: number;
    keyCache: Record<number, string>;
    /** 某一类取令牌、建令牌失败的原因（显示在下拉框下面）。 */
    slotErrors: Partial<Record<FitKind, string>>;
    /** openai.fit 换了人，等用户决定要不要改用新账号（弹窗见 fit-bridge.tsx）。 */
    accountSwitch: AccountSwitch | null;
    /** 静默登录画布前等用户同意同步本机画布项目。 */
    projectConsent: ProjectConsent | null;
    notify: Notify;
    init: (notify: Notify) => void;
    setConnection: (connection: FitBridgeConnection) => void;
    probe: (options?: { login?: boolean }) => Promise<void>;
    checkPresence: () => Promise<void>;
    chooseToken: (kind: FitKind, tokenId: number) => Promise<void>;
    createToken: (kind: FitKind, group: string) => Promise<void>;
    confirmAccountSwitch: () => void;
    declineAccountSwitch: () => void;
    confirmProjectSync: () => void;
    declineProjectSync: () => void;
    /** 「退出并清除令牌」：内存里取过的密钥、令牌列表和 fit 用户一起清掉。 */
    forgetFitSession: () => void;
    startSignIn: () => void;
    enableAutoLogin: () => void;
    disableAutoLogin: () => void;
    retry: () => void;
    retryLogin: () => void;
};

/** 往 iframe 发消息的函数（组件在桥接页 ready 之后接上）和还在等回应的请求。 */
let post: ((message: object) => void) | null = null;
const pending = new Map<string, { resolve: (message: FitBridgeIncoming) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let helloInFlight = false;
let lastHelloAt = 0;
let probeTimer: ReturnType<typeof setTimeout> | null = null;
/** 本次页面加载里自动登录失败过：不再自动重试，只能手动点「重试」。 */
let loginFailedThisPage = false;
/** 画布账号跟着 fit 换了人，下一次 hello 要带登录请求。 */
let reloginPending = false;
/** 本次页面加载里用户已经同意把本机画布项目同步进这个 fit 账号的画布账号。 */
let consentedFitUserId = 0;
/** 同一时间只做一件事（hello 和它的后续、ping、换令牌、建令牌）：桥接页每类请求也只收一个，撞上会回 rate_limited。 */
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
}

export function attachFitBridge(sender: (message: object) => void) {
    post = sender;
}

export function detachFitBridge() {
    post = null;
    helloInFlight = false;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    for (const [rid, request] of pending) {
        clearTimeout(request.timer);
        request.reject(new FitBridgeRequestError("network"));
        pending.delete(rid);
    }
}

/** 桥接页的回应按 rid 交给等它的请求；对不上的丢弃。 */
export function receiveFitBridgeMessage(message: FitBridgeIncoming) {
    const request = pending.get(message.rid);
    if (!request) return;
    pending.delete(message.rid);
    clearTimeout(request.timer);
    if (message.kind === "error") request.reject(new FitBridgeRequestError(message.error, message.message));
    else request.resolve(message);
}

function bridgeRequest(build: (rid: string) => object): Promise<FitBridgeIncoming> {
    if (!post) return Promise.reject(new FitBridgeRequestError("network"));
    const rid = newRid(globalThis.crypto);
    const send = post;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pending.delete(rid);
            reject(new FitBridgeRequestError("network"));
        }, FIT_BRIDGE_REQUEST_TIMEOUT_MS);
        pending.set(rid, { resolve, reject, timer });
        send(build(rid));
    });
}

async function requestKeys(tokenIds: number[]) {
    const reply = await bridgeRequest((rid) => bridgeKeys(rid, tokenIds));
    if (reply.kind !== "keys") throw new FitBridgeRequestError("server");
    return reply.keys;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "openai.fit 暂时出错，请稍后再试");

function canvasNeedsLogin() {
    const { token, isReady } = useUserStore.getState();
    const fitLogin = useConfigStore.getState().publicSettings?.auth?.fitLogin === true;
    return needsCanvasLogin({ pathname: globalThis.location?.pathname || "", fitLogin, userReady: isReady, userToken: token });
}

export const useFitBridgeStore = create<FitBridgeStore>()((set, get) => {
    const context = (): KeySelectContext => {
        const { tokens, tokensTotal, groups, fitUser, byGroup } = get();
        return { tokens, tokensTotal, groups, userGroup: fitUser?.group || "", byGroup, now: Math.floor(Date.now() / 1000) };
    };
    const rateLimited = (error: unknown) => (error instanceof FitBridgeRequestError && error.code === "rate_limited" ? { retryBlockedUntil: Date.now() + 60_000 } : {});
    const slotOf = (token: FitBridgeToken, apiKey: string): FitKeySlot => ({ tokenId: token.id, name: token.name, group: token.group, apiKey });
    const rememberAccount = () => {
        const user = get().fitUser;
        if (user) useConfigStore.getState().setFitAccount({ userId: user.id, displayName: user.displayName, checkedAt: Date.now() });
    };
    const refreshModels = () => useConfigStore.getState().refreshFitModels().catch(() => null);
    /** fit 退出或换了人：桥接页取来的令牌（连同内存里的密钥缓存）清掉，手动令牌保留。 */
    const forgetBridgeKeys = (text?: string) => {
        const configStore = useConfigStore.getState();
        const had = FIT_KINDS.some((kind) => configStore.config.fitKeys[kind]);
        configStore.clearBridgeFitKeys();
        clearFitKeysChecked();
        set({ keyCache: {}, slotErrors: {}, keysChecked: false });
        if (had && text) get().notify("info", text);
    };

    /** 槽位没齐或失效时按规则挑令牌、取密钥（同一把只取一次），填好后同步模型列表。 */
    const syncKeys = async () => {
        const catalog = await fetchFitCatalog().catch(() => null);
        let byGroup: GroupKindModels | null = null;
        try {
            byGroup = catalog ? groupKindModels(catalog) : null;
        } catch {
            byGroup = null;
        }
        set({ byGroup });
        const config = useConfigStore.getState().config;
        const firstTime = !FIT_KINDS.some((kind) => config.fitKeys[kind]);
        const plan = planFitKeySlots(config.fitKeys, context());
        const need: number[] = [];
        for (const kind of FIT_KINDS) {
            const token = plan.assign[kind];
            if (!token || config.fitKeys[kind]?.tokenId === token.id || get().keyCache[token.id] || need.includes(token.id)) continue;
            need.push(token.id);
        }
        if (need.length) {
            try {
                const keys = await requestKeys(need);
                set((state) => ({ keyCache: { ...state.keyCache, ...keys } }));
            } catch (error) {
                const text = `取令牌失败：${errorText(error)}`;
                set((state) => ({ lastError: text, ...rateLimited(error), slotErrors: { ...state.slotErrors, ...Object.fromEntries(FIT_KINDS.filter((kind) => plan.assign[kind]).map((kind) => [kind, text])) } }));
                return;
            }
        }
        const filled: string[] = [];
        let changed = false;
        const slotErrors: Partial<Record<FitKind, string>> = {};
        for (const kind of FIT_KINDS) {
            if (!(kind in plan.assign)) continue;
            const token = plan.assign[kind];
            const slot = config.fitKeys[kind];
            if (!token) {
                useConfigStore.getState().setFitKeySlot(kind, null);
                changed = true;
                continue;
            }
            const apiKey = slot?.tokenId === token.id ? slot.apiKey : get().keyCache[token.id];
            if (!apiKey) {
                slotErrors[kind] = "这把令牌已被删除";
                continue;
            }
            useConfigStore.getState().setFitKeySlot(kind, slotOf(token, apiKey));
            if (slot?.apiKey !== apiKey) {
                changed = true;
                filled.push(`${FIT_KIND_LABELS[kind]}「${token.name}」`);
            }
        }
        set({ slotErrors });
        // 还有某一类没有能用的令牌：这个标签页之后打开页面不为它再挂桥接页（设置里照常能选、能新建）
        if (FIT_KINDS.some((kind) => !useConfigStore.getState().config.fitKeys[kind])) {
            writeFitKeysChecked();
            set({ keysChecked: true });
        }
        for (const replaced of plan.replaced) get().notify("warning", replacedSlotText(replaced));
        rememberAccount();
        if (changed || !useConfigStore.getState().config.fitTokenCheckedAt) await refreshModels();
        if (firstTime && filled.length) get().notify("success", `已自动选好令牌：${filled.join("、")}，可在设置里更换`);
    };

    const loginWithCode = async (code: string, login: { state: string; verifier: string }, displayName: string) => {
        set({ loginState: "pending", loginError: "" });
        try {
            await useUserStore.getState().loginWithFit({ code, codeVerifier: login.verifier, state: login.state });
            set({ loginState: "idle", signedInAt: Date.now() });
            get().notify("success", `已用 openai.fit 账号 ${displayName} 登录`);
        } catch (error) {
            loginFailedThisPage = true;
            set({ loginState: "failed", loginError: errorText(error) });
        }
    };

    /** 发一次 hello（需要时带登录请求）并处理结果：fit 退出、fit 换人（先问）、自动登录（本机项目没同步过先问）、三把令牌。 */
    const handleHello = async (forceLogin: boolean) => {
        const crypto = globalThis.crypto;
        const wantLogin = forceLogin || reloginPending || (canvasNeedsLogin() && !loginFailedThisPage);
        reloginPending = false;
        let login: { state: string; verifier: string; codeChallenge: string } | null = null;
        let reply: FitBridgeIncoming;
        try {
            if (wantLogin && crypto?.subtle) {
                const verifier = randomToken(crypto);
                login = { state: randomToken(crypto), verifier, codeChallenge: await pkceChallenge(verifier, crypto) };
            }
            const hello = login ? { state: login.state, codeChallenge: login.codeChallenge } : undefined;
            reply = await bridgeRequest((rid) => bridgeHello(rid, hello));
        } catch (error) {
            set({ lastError: errorText(error), ...rateLimited(error) });
            return;
        }
        if (reply.kind !== "status") return;
        set({ statusFresh: true, presenceChecked: true });
        if (!reply.loggedIn) {
            set({ fitLoggedIn: false, fitUser: null, groups: [], tokens: [], tokensTotal: 0, statusAt: Date.now(), lastError: "" });
            // 令牌是按某个 fit 账号自动取的：fit 退出了就不留（公用电脑上下一个人用不到）；手动令牌不动
            if (useConfigStore.getState().config.fitAccount) forgetBridgeKeys(FIT_SIGNED_OUT_TEXT);
            return;
        }
        set({ fitLoggedIn: true, fitUser: reply.user, groups: reply.groups, tokens: reply.tokens, tokensTotal: reply.tokensTotal, statusAt: Date.now(), lastError: "", pendingSignIn: false });
        const configStore = useConfigStore.getState();
        // 1. openai.fit 换了人：原账号的三把令牌马上清掉（手动令牌不动），新账号的令牌和画布账号等用户点头（弹窗）才用
        const account = configStore.config.fitAccount;
        const canvasUser = useUserStore.getState().user;
        const keysOther = Boolean(account && account.userId !== reply.user.id);
        const canvasOther = Boolean(canvasUser?.fitUserId && canvasUser.fitUserId !== reply.user.id);
        if (keysOther || canvasOther) {
            if (keysOther) {
                for (const kind of FIT_KINDS) if (configStore.config.fitKeys[kind]) configStore.setFitKeySlot(kind, null);
                clearFitKeysChecked();
            }
            set({ keyCache: {}, ...(keysOther ? { keysChecked: false } : {}) });
            if (get().accountSwitch?.to.id !== reply.user.id) set({ accountSwitch: { from: account?.displayName || canvasUser?.displayName || canvasUser?.username || "", to: reply.user, keys: keysOther, canvas: canvasOther } });
            return;
        }
        if (account) configStore.setFitAccount({ ...account, displayName: reply.user.displayName, checkedAt: Date.now() });
        // 2. 自动登录画布：本机有没同步到这个 fit 账号的画布项目时先问（登录后会同步进去），同意后重新要登录码
        if (login && reply.code) {
            const projects = consentedFitUserId === reply.user.id ? 0 : await localCanvasProjectCount().catch(() => 0);
            if (asksBeforeProjectSync(projects, readCanvasProjectsOwner(), reply.user.id)) {
                if (get().projectConsent?.fitUser.id !== reply.user.id) set({ projectConsent: { fitUser: reply.user, projects } });
            } else await loginWithCode(reply.code, login, reply.user.displayName);
        } else if (login && reply.codeError === "disabled") {
            set({ codeDisabled: true });
        } else if (login && reply.codeError) {
            loginFailedThisPage = true;
            set({ loginState: "failed", loginError: "openai.fit 太忙，请稍后重试" });
        }
        // 3. 令牌：用手动令牌时不动
        if (!normalizeFitApiKey(useConfigStore.getState().config.fitManualKey)) await syncKeys();
    };

    return {
        connection: "idle",
        fitLoggedIn: null,
        fitUser: null,
        groups: [],
        tokens: [],
        tokensTotal: 0,
        byGroup: null,
        statusAt: 0,
        statusFresh: false,
        presenceChecked: false,
        keysChecked: false,
        lastError: "",
        loginState: "idle",
        loginError: "",
        signedInAt: 0,
        codeDisabled: false,
        pendingSignIn: false,
        autoLoginOff: false,
        frameKey: 0,
        retryBlockedUntil: 0,
        keyCache: {},
        slotErrors: {},
        accountSwitch: null,
        projectConsent: null,
        notify: () => undefined,
        init: (notify) => set({ notify, autoLoginOff: readFitAutoLoginOff(), keysChecked: readFitKeysChecked() }),
        setConnection: (connection) => set({ connection, statusFresh: false, ...(connection === "ready" ? { lastError: "" } : {}) }),
        probe: async ({ login: forceLogin = false } = {}) => {
            if (get().connection !== "ready" || !post || helloInFlight) return;
            const wait = lastHelloAt + FIT_BRIDGE_HELLO_GAP_MS - Date.now();
            if (wait > 0) {
                if (probeTimer) clearTimeout(probeTimer);
                probeTimer = setTimeout(() => {
                    probeTimer = null;
                    void get().probe({ login: forceLogin });
                }, wait);
                return;
            }
            // 同一时间只走一轮（发 hello、处理结果、取令牌），换令牌、建令牌排在它后面
            helloInFlight = true;
            lastHelloAt = Date.now();
            try {
                await exclusive(() => handleHello(forceLogin));
            } finally {
                helloInFlight = false;
            }
            if (reloginPending) void get().probe();
        },
        checkPresence: () =>
            exclusive(async () => {
                if (!post) return;
                try {
                    const reply = await bridgeRequest((rid) => bridgePing(rid));
                    if (reply.kind === "presence" && !reply.session) {
                        set({ fitLoggedIn: false });
                        forgetBridgeKeys(FIT_SIGNED_OUT_TEXT);
                    }
                } catch {
                    // 连不上就等下次打开页面再核对
                }
                set({ presenceChecked: true });
            }),
        chooseToken: (kind, tokenId) =>
            exclusive(async () => {
                const token = get().tokens.find((item) => item.id === tokenId);
                if (!token) return;
                const fitKeys = useConfigStore.getState().config.fitKeys;
                let apiKey = get().keyCache[tokenId] || FIT_KINDS.map((item) => fitKeys[item]).find((slot) => slot?.tokenId === tokenId)?.apiKey || "";
                set((state) => ({ slotErrors: { ...state.slotErrors, [kind]: undefined } }));
                if (!apiKey) {
                    try {
                        const keys = await requestKeys([tokenId]);
                        apiKey = keys[tokenId] || "";
                        set((state) => ({ keyCache: { ...state.keyCache, ...keys } }));
                    } catch (error) {
                        set((state) => ({ ...rateLimited(error), slotErrors: { ...state.slotErrors, [kind]: `取令牌失败：${errorText(error)}` } }));
                        return;
                    }
                }
                if (!apiKey) {
                    set((state) => ({ tokens: state.tokens.filter((item) => item.id !== tokenId), slotErrors: { ...state.slotErrors, [kind]: "这把令牌已被删除" } }));
                    return;
                }
                useConfigStore.getState().setFitKeySlot(kind, slotOf(token, apiKey));
                rememberAccount();
                await refreshModels();
            }),
        createToken: (kind, group) =>
            exclusive(async () => {
                set((state) => ({ slotErrors: { ...state.slotErrors, [kind]: undefined } }));
                let reply: FitBridgeIncoming;
                try {
                    reply = await bridgeRequest((rid) => bridgeCreate(rid, kind, group));
                } catch (error) {
                    const text = error instanceof FitBridgeRequestError && error.code === "token_limit" ? error.message : `新建令牌失败：${errorText(error)}`;
                    set((state) => ({ ...rateLimited(error), slotErrors: { ...state.slotErrors, [kind]: text } }));
                    return;
                }
                if (reply.kind !== "created") return;
                const created = reply.token;
                set((state) => ({ tokens: [created, ...state.tokens.filter((item) => item.id !== created.id)], tokensTotal: state.tokensTotal + 1 }));
                if (!reply.key) {
                    set((state) => ({ slotErrors: { ...state.slotErrors, [kind]: `令牌「${created.name}」已建好，但取令牌失败：${bridgeErrorText(reply.keyError || "server")}，请稍后在下拉框里选它` } }));
                    return;
                }
                const key = reply.key;
                set((state) => ({ keyCache: { ...state.keyCache, [created.id]: key } }));
                const configStore = useConfigStore.getState();
                configStore.setFitKeySlot(kind, slotOf(created, key));
                // 新令牌可能同时满足别的空槽位（例如 default 分组既有视频也有图片）
                for (const other of FIT_KINDS) {
                    if (other === kind || useConfigStore.getState().config.fitKeys[other]) continue;
                    const picked = pickToken(other, context());
                    const pickedKey = picked && get().keyCache[picked.id];
                    if (picked && pickedKey) configStore.setFitKeySlot(other, slotOf(picked, pickedKey));
                }
                rememberAccount();
                get().notify("success", `已新建令牌「${created.name}」`);
                await refreshModels();
            }),
        confirmAccountSwitch: () => {
            const change = get().accountSwitch;
            if (!change) return;
            set({ accountSwitch: null, keyCache: {} });
            // 原账号的令牌在发现换人时已经清掉；改记成新账号，下一轮 hello 按新账号挑令牌
            if (change.keys) useConfigStore.getState().setFitAccount({ userId: change.to.id, displayName: change.to.displayName, checkedAt: Date.now() });
            if (change.canvas) {
                // 弹窗里已经说了本机画布项目会同步过去，不再单独问
                consentedFitUserId = change.to.id;
                useUserStore.getState().clearSession();
                reloginPending = true;
            }
            void get().probe();
        },
        declineAccountSwitch: () => {
            const change = get().accountSwitch;
            set({ accountSwitch: null });
            get().disableAutoLogin();
            if (change) get().notify("info", `已停止自动连接 openai.fit。要改用「${change.to.displayName}」，请在设置里点「用 openai.fit 登录」`);
        },
        confirmProjectSync: () => {
            const consent = get().projectConsent;
            if (!consent) return;
            consentedFitUserId = consent.fitUser.id;
            loginFailedThisPage = false;
            set({ projectConsent: null });
            // 原来那个登录码 60 秒就过期，重新要一个
            void get().probe({ login: true });
        },
        declineProjectSync: () => {
            set({ projectConsent: null });
            get().disableAutoLogin();
            get().notify("info", "没有登录画布账号，本机的画布项目不会同步。要登录请点「用 openai.fit 登录」，或用画布账号登录");
        },
        forgetFitSession: () => set({ keyCache: {}, tokens: [], groups: [], tokensTotal: 0, fitUser: null, fitLoggedIn: null, byGroup: null, slotErrors: {}, statusAt: 0, statusFresh: false }),
        startSignIn: () => set({ pendingSignIn: true }),
        enableAutoLogin: () => {
            writeFitAutoLoginOff(false);
            loginFailedThisPage = false;
            set({ autoLoginOff: false, loginState: "idle", loginError: "" });
            void get().probe({ login: canvasNeedsLogin() });
        },
        disableAutoLogin: () => {
            writeFitAutoLoginOff(true);
            set({ autoLoginOff: true, pendingSignIn: false });
        },
        retry: () => set((state) => ({ frameKey: state.frameKey + 1, connection: "idle", lastError: "" })),
        retryLogin: () => {
            loginFailedThisPage = false;
            set({ loginState: "idle", loginError: "" });
            void get().probe({ login: true });
        },
    };
});
