import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";

// 浏览器环境：store 读写 localStorage / sessionStorage、按 location 判断是不是登录页；本机画布项目数由测试控制
const memory = () => {
    const stored = new Map<string, string>();
    return { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, String(value)), removeItem: (key: string) => void stored.delete(key), clear: () => stored.clear() };
};
const globals = globalThis as Record<string, unknown>;
const createdGlobals = ["localStorage", "sessionStorage", "location"].filter((name) => !(name in globals));
globals.localStorage ??= memory();
globals.sessionStorage ??= memory();
globals.location ??= { pathname: "/canvas/demo" };
let localProjects = 0;
// bun 的 mock.module（tsc 没有 bun:test 的类型，按变量名导入）
const bunTest = "bun:test";
const { mock } = (await import(bunTest)) as { mock: { module: (specifier: string, factory: () => unknown) => void } };
mock.module("@/lib/canvas-local-projects", () => ({ localCanvasProjectCount: async () => localProjects }));

const { FIT_BRIDGE_CHANNEL, FIT_KEYS_CHECKED_KEY, CANVAS_PROJECTS_OWNER_KEY, parseBridgeMessage } = await import("@/lib/fit-bridge");
const { normalizeFitConfig } = await import("@/lib/fit-config");
const { defaultConfig, useConfigStore } = await import("@/stores/use-config-store");
const { useUserStore } = await import("@/stores/use-user-store");
const { attachFitBridge, detachFitBridge, receiveFitBridgeMessage, useFitBridgeStore } = await import("@/stores/use-fit-bridge-store");

const KEY = (n: number) => `sk-token${n}-0123456789abcdef`;
const slot = (tokenId: number) => ({ tokenId, name: `令牌${tokenId}`, group: "", apiKey: KEY(tokenId) });
const token = (id: number) => ({ id, name: `令牌${id}`, group: "", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true, auto_groups: [] });
const user = (id: number, displayName: string) => ({ id, displayName, group: "default" });
const realNow = Date.now;
let clock = realNow();
const tick = (ms: number) => (clock += ms);
const flush = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

type Sent = { kind: string; rid: string; login?: unknown; tokenIds?: number[] };
/** 假的桥接页：记下画布发出的消息，测试决定什么时候、怎么回。 */
function fakeBridge() {
    const sent: Sent[] = [];
    attachFitBridge((message) => sent.push(message as Sent));
    useFitBridgeStore.getState().setConnection("ready");
    const answer = (kind: string, data: Record<string, unknown>) => {
        const request = [...sent].reverse().find((item) => item.kind === kind);
        assert.ok(request, `no ${kind} sent`);
        const frame = {};
        const parsed = parseBridgeMessage({ origin: "https://openai.fit", source: frame, data: { channel: FIT_BRIDGE_CHANNEL, rid: request.rid, ...data } }, frame);
        assert.ok(parsed, `bad reply to ${kind}`);
        receiveFitBridgeMessage(parsed);
    };
    return { sent, kinds: () => sent.map((item) => item.kind), answer };
}

const relayCalls: string[] = [];
const authCalls: unknown[] = [];
const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter };

function reset(config: Partial<ReturnType<typeof useConfigStore.getState>["config"]>) {
    detachFitBridge();
    tick(3_600_000);
    localProjects = 0;
    (globals.localStorage as { clear: () => void }).clear();
    (globals.sessionStorage as { clear: () => void }).clear();
    useConfigStore.setState({ config: { ...normalizeFitConfig(defaultConfig), fitTokenCheckedAt: 1, ...config }, publicSettings: null });
    useUserStore.setState({ token: "", user: null, isReady: true });
    useFitBridgeStore.setState({ connection: "idle", fitLoggedIn: null, fitUser: null, tokens: [], tokensTotal: 0, keyCache: {}, slotErrors: {}, accountSwitch: null, projectConsent: null, autoLoginOff: false, presenceChecked: false, statusFresh: false, notify: () => undefined });
}

test.before(() => {
    Date.now = () => clock;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        relayCalls.push(String(input));
        return Response.json({ success: true, object: "list", data: [] });
    }) as typeof fetch;
    const adapter: AxiosAdapter = async (config) => {
        const reply = (data: unknown) => ({ data, status: 200, statusText: "", headers: {}, config });
        // 目录拿不到：按降级规则只看令牌状态和分组，不按模型数换掉已选的令牌
        if (config.url === "/api/fit/catalog") throw new Error("catalog unavailable in this test");
        if (config.url === "/api/auth/fit/login") {
            authCalls.push(JSON.parse(String(config.data)));
            return reply({ code: 0, data: { token: "canvas-jwt", user: { id: "u-9", username: "fit_9", displayName: "乙", avatarUrl: "", role: "user", credits: 0, createdAt: "", updatedAt: "", fitUserId: 9 } }, msg: "" });
        }
        throw new Error(`unexpected canvas server call ${config.url}`);
    };
    axios.defaults.adapter = adapter;
});

test.after(() => {
    detachFitBridge();
    Date.now = realNow;
    globalThis.fetch = original.fetch;
    axios.defaults.adapter = original.adapter;
    for (const name of createdGlobals) delete globals[name];
});

test("ping: openai.fit signed out drops the keys the bridge picked (and its account and key cache), the manual key stays", async () => {
    reset({ fitKeys: { video: slot(1), image: slot(2), text: slot(3) }, fitAccount: { userId: 7, displayName: "甲" }, fitManualKey: "sk-manual-0123456789abcdef" });
    useFitBridgeStore.setState({ keyCache: { 1: KEY(1) }, keysChecked: true });
    (globals.sessionStorage as Storage).setItem(FIT_KEYS_CHECKED_KEY, "1");
    const bridge = fakeBridge();

    const done = useFitBridgeStore.getState().checkPresence();
    await flush();
    assert.deepEqual(bridge.kinds(), ["ping"]);
    bridge.answer("ping", { kind: "presence", session: false });
    await done;

    const config = useConfigStore.getState().config;
    assert.deepEqual([config.fitKeys, config.fitAccount, config.fitManualKey], [{}, undefined, "sk-manual-0123456789abcdef"]);
    assert.deepEqual(useFitBridgeStore.getState().keyCache, {});
    assert.equal(useFitBridgeStore.getState().presenceChecked, true);
    // 令牌没了，下次打开页面要重新挑：「这个标签页挑过一轮」的标记也清掉
    assert.equal(useFitBridgeStore.getState().keysChecked, false);
    assert.equal((globals.sessionStorage as Storage).getItem(FIT_KEYS_CHECKED_KEY), null);
});

test("ping: openai.fit still signed in keeps the keys and sends nothing else", async () => {
    reset({ fitKeys: { video: slot(1), image: slot(2), text: slot(3) }, fitAccount: { userId: 7, displayName: "甲" } });
    const bridge = fakeBridge();

    const done = useFitBridgeStore.getState().checkPresence();
    await flush();
    bridge.answer("ping", { kind: "presence", session: true });
    await done;

    assert.equal(useConfigStore.getState().config.fitKeys.video?.apiKey, KEY(1));
    assert.deepEqual(bridge.kinds(), ["ping"]);
});

test("hello answered loggedIn:false drops the keys the bridge picked; keys without a recorded fit account (pasted ones) stay", async () => {
    reset({ fitKeys: { video: slot(1) }, fitAccount: { userId: 7, displayName: "甲" } });
    const bridge = fakeBridge();
    const done = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: false });
    await done;
    assert.deepEqual([useConfigStore.getState().config.fitKeys, useConfigStore.getState().config.fitAccount], [{}, undefined]);
    assert.equal(useFitBridgeStore.getState().fitLoggedIn, false);
});

test("openai.fit signed in as someone else: the old account's keys are dropped at once, nothing of the new account is used until the user says so", async () => {
    reset({ fitKeys: { video: slot(1), image: slot(2), text: slot(3) }, fitAccount: { userId: 7, displayName: "甲" } });
    useFitBridgeStore.setState({ keyCache: { 1: KEY(1) } });
    const bridge = fakeBridge();

    const done = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(9, "乙"), groups: [], tokens: [token(21)], tokensTotal: 1 });
    await done;
    await flush();

    const config = useConfigStore.getState().config;
    assert.deepEqual(config.fitKeys, {});
    assert.equal(config.fitAccount?.userId, 7, "still the old account until the user agrees");
    assert.deepEqual(useFitBridgeStore.getState().keyCache, {});
    assert.deepEqual(useFitBridgeStore.getState().accountSwitch, { from: "甲", to: user(9, "乙"), keys: true, canvas: false });
    assert.deepEqual(bridge.kinds(), ["hello"], "no key of the new account is fetched");

    // 再来一次 hello 也不会悄悄选上新账号的令牌
    tick(5_000);
    const again = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(9, "乙"), groups: [], tokens: [token(21)], tokensTotal: 1 });
    await again;
    await flush();
    assert.deepEqual(bridge.kinds(), ["hello", "hello"]);
    assert.deepEqual(useConfigStore.getState().config.fitKeys, {});

    useFitBridgeStore.getState().confirmAccountSwitch();
    assert.equal(useFitBridgeStore.getState().accountSwitch, null);
    assert.equal(useConfigStore.getState().config.fitAccount?.userId, 9);
});

test("declining the account switch stops connecting to openai.fit automatically", async () => {
    reset({ fitKeys: { video: slot(1) }, fitAccount: { userId: 7, displayName: "甲" } });
    const bridge = fakeBridge();
    const done = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(9, "乙"), groups: [], tokens: [], tokensTotal: 0 });
    await done;

    useFitBridgeStore.getState().declineAccountSwitch();

    assert.equal(useFitBridgeStore.getState().accountSwitch, null);
    assert.equal(useFitBridgeStore.getState().autoLoginOff, true);
    assert.deepEqual(useConfigStore.getState().config.fitKeys, {});
});

test("choosing a token while a hello is still being handled waits for it instead of colliding with the bridge's one-at-a-time limit", async () => {
    reset({ fitKeys: { video: slot(1), image: slot(2), text: slot(3) }, fitAccount: { userId: 7, displayName: "甲" } });
    useFitBridgeStore.setState({ tokens: [token(1), token(2), token(3), token(5)] });
    const bridge = fakeBridge();

    const hello = useFitBridgeStore.getState().probe();
    await flush();
    const choose = useFitBridgeStore.getState().chooseToken("video", 5);
    await flush();
    assert.deepEqual(bridge.kinds(), ["hello"]);

    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(7, "甲"), groups: [], tokens: [token(1), token(2), token(3), token(5)], tokensTotal: 4 });
    await hello;
    await flush();
    assert.deepEqual(bridge.kinds(), ["hello", "keys"]);
    bridge.answer("keys", { kind: "keys", keys: { 5: KEY(5) } });
    await choose;
    assert.equal(useConfigStore.getState().config.fitKeys.video?.tokenId, 5);
});

test("a re-mounted bridge is not usable for choosing tokens until its own hello came back", async () => {
    reset({});
    useFitBridgeStore.setState({ fitLoggedIn: true, statusFresh: true });
    const bridge = fakeBridge();
    assert.equal(useFitBridgeStore.getState().statusFresh, false);
    const done = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(7, "甲"), groups: [], tokens: [], tokensTotal: 0 });
    await done;
    assert.equal(useFitBridgeStore.getState().statusFresh, true);
});

test("forgetFitSession (log out and clear keys) also drops the keys, token list and fit user kept in memory", () => {
    reset({});
    useFitBridgeStore.setState({ keyCache: { 1: KEY(1) }, tokens: [token(1)], tokensTotal: 1, fitUser: user(7, "甲"), fitLoggedIn: true, statusFresh: true });
    useFitBridgeStore.getState().forgetFitSession();
    const state = useFitBridgeStore.getState();
    assert.deepEqual([state.keyCache, state.tokens, state.tokensTotal, state.fitUser, state.fitLoggedIn, state.statusFresh], [{}, [], 0, null, null, false]);
});

test("silent login with local canvas projects that never synced to this fit account asks first and does not log in", async () => {
    reset({ fitManualKey: "sk-manual-0123456789abcdef" });
    useConfigStore.setState({ publicSettings: { auth: { fitLogin: true } } as never });
    localProjects = 2;
    authCalls.length = 0;
    const bridge = fakeBridge();

    const done = useFitBridgeStore.getState().probe();
    await flush();
    assert.ok(bridge.sent[0].login, "hello asks for a login code");
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(9, "乙"), groups: [], tokens: [], tokensTotal: 0, code: "C".repeat(43) });
    await done;
    await flush();

    assert.deepEqual(useFitBridgeStore.getState().projectConsent, { fitUser: user(9, "乙"), projects: 2 });
    assert.deepEqual(authCalls, []);
    assert.equal(useUserStore.getState().token, "");

    // 同意后重新要一个登录码（原来那个 60 秒就过期）再登录
    tick(5_000);
    useFitBridgeStore.getState().confirmProjectSync();
    await flush();
    const relogin = bridge.sent[bridge.sent.length - 1];
    assert.equal(relogin.kind, "hello");
    assert.ok(relogin.login);
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(9, "乙"), groups: [], tokens: [], tokensTotal: 0, code: "D".repeat(43) });
    await flush();
    assert.equal(authCalls.length, 1);
    assert.equal(useUserStore.getState().token, "canvas-jwt");
});

test("silent login goes ahead without asking when there are no local projects or they already belong to this fit account", async () => {
    reset({ fitManualKey: "sk-manual-0123456789abcdef" });
    useConfigStore.setState({ publicSettings: { auth: { fitLogin: true } } as never });
    localProjects = 4;
    (globals.localStorage as Storage).setItem(CANVAS_PROJECTS_OWNER_KEY, "fit:9");
    authCalls.length = 0;
    const bridge = fakeBridge();

    const done = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(9, "乙"), groups: [], tokens: [], tokensTotal: 0, code: "C".repeat(43) });
    await done;
    await flush();

    assert.equal(useFitBridgeStore.getState().projectConsent, null);
    assert.equal(authCalls.length, 1);
});

test("declining the project sync keeps the canvas logged out and stops automatic login", async () => {
    reset({ fitManualKey: "sk-manual-0123456789abcdef" });
    useConfigStore.setState({ publicSettings: { auth: { fitLogin: true } } as never });
    localProjects = 1;
    const bridge = fakeBridge();
    const done = useFitBridgeStore.getState().probe();
    await flush();
    bridge.answer("hello", { kind: "status", loggedIn: true, user: user(11, "丙"), groups: [], tokens: [], tokensTotal: 0, code: "C".repeat(43) });
    await done;
    await flush();

    // 另一个 fit 用户：本页没同意过
    assert.deepEqual(useFitBridgeStore.getState().projectConsent, { fitUser: user(11, "丙"), projects: 1 });
    useFitBridgeStore.getState().declineProjectSync();

    assert.equal(useFitBridgeStore.getState().projectConsent, null);
    assert.equal(useFitBridgeStore.getState().autoLoginOff, true);
    assert.equal(useUserStore.getState().token, "");
});
