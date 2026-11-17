import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
    CANVAS_PROJECTS_OWNER_KEY,
    FIT_AUTO_LOGIN_OFF_KEY,
    FIT_BRIDGE_CHANNEL,
    FIT_BRIDGE_URL,
    FIT_KEYS_CHECKED_KEY,
    accountSwitchText,
    asksBeforeProjectSync,
    bridgeCreate,
    bridgeHello,
    bridgeKeys,
    bridgeOpening,
    bridgePing,
    canvasProjectsOwner,
    clearFitKeysChecked,
    newRid,
    parseBridgeMessage,
    pkceChallenge,
    randomToken,
    readCanvasProjectsOwner,
    readFitAutoLoginOff,
    readFitKeysChecked,
    shouldMountBridge,
    writeCanvasProjectsOwner,
    writeFitAutoLoginOff,
    writeFitKeysChecked,
    type BridgeMountInput,
} from "./fit-bridge";

const crypto = webcrypto as unknown as Crypto;
const frame = { name: "the iframe's contentWindow" };
const KEY = "sk-abcdefghijklmnop0123";
const CODE = "C".repeat(43);
const token = { id: 7, name: "无限画布-视频", group: "", status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true, auto_groups: [] };
const loggedIn = { channel: FIT_BRIDGE_CHANNEL, kind: "status", rid: "rid-hello-1", loggedIn: true, user: { id: 42, displayName: "叶悠", group: "default" }, groups: [{ name: "default", desc: "默认分组", ratio: 1 }, { name: "auto", desc: "自动", ratio: null }], tokens: [token], tokensTotal: 1 };
const from = (data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) => parseBridgeMessage({ origin: "https://openai.fit", source: frame, data, ...overrides }, frame);

test("only messages from https://openai.fit and from our own iframe, on our channel, with a valid rid, are accepted", () => {
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "ready", rid: "ready000" }), { kind: "ready", rid: "ready000" });
    for (const origin of ["https://evil.example", "http://openai.fit", "https://canvas.openai.fit", "null"]) assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "ready", rid: "ready000" }, { origin }), null, origin);
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "ready", rid: "ready000" }, { source: { name: "another window" } }), null);
    assert.equal(parseBridgeMessage({ origin: "https://openai.fit", source: null, data: { channel: FIT_BRIDGE_CHANNEL, kind: "ready", rid: "ready000" } }, null), null);
    assert.equal(from({ channel: "other/1", kind: "ready", rid: "ready000" }), null);
    for (const rid of ["short", "has space here", "x".repeat(65), 12345678]) assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "ready", rid }), null, String(rid));
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "hello", rid: "ready000" }), null);
    assert.equal(from("not an object"), null);
});

test("status: logged out, logged in with tokens and a code; malformed fields are rejected", () => {
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "status", rid: "rid-hello-1", loggedIn: false }), { kind: "status", rid: "rid-hello-1", loggedIn: false });
    const status = from({ ...loggedIn, code: CODE, codeExpiresIn: 60 });
    assert.ok(status?.kind === "status" && status.loggedIn);
    assert.deepEqual(status.user, { id: 42, displayName: "叶悠", group: "default" });
    assert.deepEqual(status.groups, [{ name: "default", desc: "默认分组", ratio: 1 }, { name: "auto", desc: "自动", ratio: null }]);
    assert.deepEqual(status.tokens, [token]);
    assert.deepEqual([status.tokensTotal, status.code, status.codeExpiresIn], [1, CODE, 60]);
    // displayName 截到 64 字
    const long = from({ ...loggedIn, user: { ...loggedIn.user, displayName: "名".repeat(80) } });
    assert.ok(long?.kind === "status" && long.loggedIn && long.user.displayName.length === 64);
    // codeError 只认三种
    const disabled = from({ ...loggedIn, codeError: "disabled" });
    assert.ok(disabled?.kind === "status" && disabled.loggedIn && disabled.codeError === "disabled");
    const unknown = from({ ...loggedIn, codeError: "whatever" });
    assert.ok(unknown?.kind === "status" && unknown.loggedIn && unknown.codeError === undefined);
    for (const bad of [
        { ...loggedIn, user: { id: 0, displayName: "x" } },
        { ...loggedIn, user: { id: "42", displayName: "x" } },
        { ...loggedIn, code: "short" },
        { ...loggedIn, tokens: [{ ...token, id: -1 }] },
        { ...loggedIn, tokens: [{ ...token, unlimited_quota: "yes" }] },
        { ...loggedIn, tokens: Array.from({ length: 101 }, (_, index) => ({ ...token, id: index + 1 })) },
        { ...loggedIn, groups: "default" },
        { ...loggedIn, loggedIn: "yes" },
    ])
        assert.equal(from(bad), null, JSON.stringify(bad).slice(0, 80));
});

test("keys: well-formed sk- keys only; anything else is dropped (treated as a deleted token)", () => {
    const reply = from({ channel: FIT_BRIDGE_CHANNEL, kind: "keys", rid: "rid-keys-1", keys: { 7: KEY, 8: "sk-short", 9: "no-prefix-abcdefghijklmnop", x: KEY, 0: KEY } });
    assert.deepEqual(reply, { kind: "keys", rid: "rid-keys-1", keys: { 7: KEY } });
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "keys", rid: "rid-keys-1", keys: [KEY] }), null);
});

test("created and error replies", () => {
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "created", rid: "rid-create", token, key: KEY }), { kind: "created", rid: "rid-create", token, key: KEY });
    // 令牌建好了但没取到密钥
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "created", rid: "rid-create", token, keyError: "rate_limited" }), { kind: "created", rid: "rid-create", token, keyError: "rate_limited" });
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "created", rid: "rid-create", token: { ...token, id: "7" }, key: KEY }), null);
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "error", rid: "rid-create", error: "token_limit", message: "已达到最大令牌数量限制 (10)" }), { kind: "error", rid: "rid-create", error: "token_limit", message: "已达到最大令牌数量限制 (10)" });
    // 只有 token_limit 带 fit 原文
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "error", rid: "rid-x-1234", error: "server", message: "stack trace" }), { kind: "error", rid: "rid-x-1234", error: "server" });
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "error", rid: "rid-x-1234", error: "teapot" }), null);
});

test("outgoing messages carry the channel and rid; create sends the slot kind as tokenKind and never a token name", () => {
    assert.deepEqual(bridgeHello("rid-hello-1"), { channel: FIT_BRIDGE_CHANNEL, kind: "hello", rid: "rid-hello-1" });
    assert.deepEqual(bridgeHello("rid-hello-1", { state: "S".repeat(43), codeChallenge: "C".repeat(43) }), { channel: FIT_BRIDGE_CHANNEL, kind: "hello", rid: "rid-hello-1", login: { state: "S".repeat(43), codeChallenge: "C".repeat(43) } });
    assert.deepEqual(bridgeKeys("rid-keys-1", [7, 8]), { channel: FIT_BRIDGE_CHANNEL, kind: "keys", rid: "rid-keys-1", tokenIds: [7, 8] });
    assert.deepEqual(bridgeCreate("rid-create", "text", "Claude"), { channel: FIT_BRIDGE_CHANNEL, kind: "create", rid: "rid-create", tokenKind: "text", group: "Claude" });
    assert.equal(FIT_BRIDGE_URL, "https://openai.fit/canvas/bridge");
    assert.match(newRid(crypto), /^[A-Za-z0-9_-]{22}$/);
});

test("PKCE: RFC 7636 appendix B vector; random state and verifier are 43 base64url characters", async () => {
    assert.equal(await pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", crypto), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const a = randomToken(crypto);
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(a, randomToken(crypto));
});

test("the do-not-auto-login flag survives storage that throws", () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) };
    assert.equal(readFitAutoLoginOff(storage), false);
    writeFitAutoLoginOff(true, storage);
    assert.equal(stored.get(FIT_AUTO_LOGIN_OFF_KEY), "1");
    assert.equal(readFitAutoLoginOff(storage), true);
    writeFitAutoLoginOff(false, storage);
    assert.equal(readFitAutoLoginOff(storage), false);
    const broken = {
        getItem: () => {
            throw new Error("SecurityError");
        },
        setItem: () => {
            throw new Error("QuotaExceededError");
        },
        removeItem: () => {
            throw new Error("SecurityError");
        },
    };
    assert.equal(readFitAutoLoginOff(broken), false);
    assert.doesNotThrow(() => writeFitAutoLoginOff(true, broken));
    assert.doesNotThrow(() => writeFitAutoLoginOff(false, broken));
    assert.equal(readFitAutoLoginOff(null), false);
});

test("shouldMountBridge: never on /admin or after logging out; otherwise when the canvas needs a login, keys are missing, settings are open or a sign-in is pending", () => {
    const idle: BridgeMountInput = { pathname: "/canvas/abc", autoLoginOff: false, fitLogin: true, userReady: true, userToken: "jwt", keysComplete: true, keysChecked: false, configOpen: false, pendingSignIn: false, presencePending: false, accountStale: false };
    assert.equal(shouldMountBridge(idle), false);
    assert.equal(shouldMountBridge({ ...idle, userToken: "" }), true);
    assert.equal(shouldMountBridge({ ...idle, userToken: "", fitLogin: false }), false);
    assert.equal(shouldMountBridge({ ...idle, userToken: "", userReady: false }), false);
    // 登录页不等 /auth/me
    assert.equal(shouldMountBridge({ ...idle, pathname: "/login", userToken: "", userReady: false }), true);
    assert.equal(shouldMountBridge({ ...idle, keysComplete: false }), true);
    assert.equal(shouldMountBridge({ ...idle, configOpen: true }), true);
    assert.equal(shouldMountBridge({ ...idle, pendingSignIn: true }), true);
    for (const pathname of ["/admin", "/admin/login", "/admin/settings"]) assert.equal(shouldMountBridge({ ...idle, pathname, keysComplete: false, userToken: "" }), false, pathname);
    assert.equal(shouldMountBridge({ ...idle, autoLoginOff: true, keysComplete: false, userToken: "", configOpen: true, pendingSignIn: true }), false);
});

test("接线（bun 导入 tsx 太慢，按源码查）：iframe 指向桥接页、sandbox 带 allow-same-origin、隐藏；只给 https://openai.fit 发消息；根组件挂上它", () => {
    const component = readFileSync(new URL("../components/layout/fit-bridge.tsx", import.meta.url), "utf8");
    assert.match(component, /<iframe key=\{frameKey\} ref=\{frameRef\} src=\{FIT_BRIDGE_URL\} title="openai\.fit" hidden aria-hidden tabIndex=\{-1\} sandbox="allow-scripts allow-same-origin" \/>/);
    assert.match(component, /frame\.postMessage\(payload, FIT_ORIGIN\)/);
    assert.match(component, /parseBridgeMessage\(event, frame\)/);
    assert.doesNotMatch(component, /postMessage\([^)]*"\*"/);
    const root = readFileSync(new URL("../components/layout/client-root-init.tsx", import.meta.url), "utf8");
    assert.match(root, /<FitBridge \/>/);
    assert.doesNotMatch(root, /fit-connect|isFitConnectPath/);
});

const memoryStorage = () => {
    const stored = new Map<string, string>();
    return { stored, storage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) } };
};
const brokenStorage = {
    getItem: (): string | null => {
        throw new Error("SecurityError");
    },
    setItem: () => {
        throw new Error("SecurityError");
    },
    removeItem: () => {
        throw new Error("SecurityError");
    },
};

test("协议注释和两边代码一致：create 的令牌类型字段叫 tokenKind，created 取 key 失败时带 keyError，还有 ping / presence", () => {
    const header = readFileSync(new URL("./fit-bridge.ts", import.meta.url), "utf8").split("*/")[0];
    assert.match(header, /create\{tokenKind, group\}/);
    assert.doesNotMatch(header, /create\{kind/);
    assert.match(header, /keyError/);
    assert.match(header, /ping/);
    assert.match(header, /presence\{session\}/);
});

test("presence: ping asks only whether the fit session hint cookie is there", () => {
    assert.deepEqual(bridgePing("rid-ping-01"), { channel: FIT_BRIDGE_CHANNEL, kind: "ping", rid: "rid-ping-01" });
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "presence", rid: "rid-ping-01", session: false }), { kind: "presence", rid: "rid-ping-01", session: false });
    assert.deepEqual(from({ channel: FIT_BRIDGE_CHANNEL, kind: "presence", rid: "rid-ping-01", session: true }), { kind: "presence", rid: "rid-ping-01", session: true });
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "presence", rid: "rid-ping-01", session: "yes" }), null);
    assert.equal(from({ channel: FIT_BRIDGE_CHANNEL, kind: "presence", rid: "rid-ping-01" }), null);
});

test("keys picked by the bridge are checked on every page load: a ping even after logging out of the canvas, never on /admin; hello only when there is work or the account check is 12 hours old", () => {
    const idle: BridgeMountInput = { pathname: "/canvas/abc", autoLoginOff: false, fitLogin: true, userReady: true, userToken: "jwt", keysComplete: true, keysChecked: false, configOpen: false, pendingSignIn: false, presencePending: false, accountStale: false };
    const presence = { ...idle, presencePending: true };
    assert.equal(shouldMountBridge(presence), true);
    assert.equal(bridgeOpening(presence), "ping");
    assert.equal(shouldMountBridge({ ...presence, autoLoginOff: true }), true);
    assert.equal(bridgeOpening({ ...presence, autoLoginOff: true }), "ping");
    assert.equal(shouldMountBridge({ ...presence, pathname: "/admin/settings" }), false);
    // 12 小时核对一次 fit 账号有没有换人（退出过画布、不自动连接时只 ping）
    assert.equal(bridgeOpening({ ...presence, accountStale: true }), "hello");
    assert.equal(bridgeOpening({ ...presence, accountStale: true, autoLoginOff: true }), "ping");
    // 有正事（设置开着、令牌没齐…）就发 hello
    assert.equal(bridgeOpening({ ...presence, configOpen: true }), "hello");
    assert.equal(bridgeOpening({ ...idle, keysComplete: false }), "hello");
});

test("keys left incomplete after this tab already checked (no usable token for a kind) do not mount the bridge again on every page load", () => {
    const idle: BridgeMountInput = { pathname: "/canvas/abc", autoLoginOff: false, fitLogin: true, userReady: true, userToken: "jwt", keysComplete: false, keysChecked: true, configOpen: false, pendingSignIn: false, presencePending: false, accountStale: false };
    assert.equal(shouldMountBridge(idle), false);
    assert.equal(shouldMountBridge({ ...idle, configOpen: true }), true);
    assert.equal(shouldMountBridge({ ...idle, userToken: "" }), true);
    const { stored, storage } = memoryStorage();
    assert.equal(readFitKeysChecked(storage), false);
    writeFitKeysChecked(storage);
    assert.equal(stored.get(FIT_KEYS_CHECKED_KEY), "1");
    assert.equal(readFitKeysChecked(storage), true);
    clearFitKeysChecked(storage);
    assert.equal(readFitKeysChecked(storage), false);
    assert.equal(readFitKeysChecked(brokenStorage), false);
    assert.doesNotThrow(() => writeFitKeysChecked(brokenStorage));
    assert.doesNotThrow(() => clearFitKeysChecked(brokenStorage));
});

test("before a silent openai.fit login, local canvas projects that were never synced to that fit account need the user's consent", () => {
    assert.equal(asksBeforeProjectSync(0, null, 42), false);
    assert.equal(asksBeforeProjectSync(3, null, 42), true);
    assert.equal(asksBeforeProjectSync(3, "fit:7", 42), true);
    assert.equal(asksBeforeProjectSync(3, "user:abc", 42), true);
    assert.equal(asksBeforeProjectSync(3, "fit:42", 42), false);
    assert.equal(canvasProjectsOwner({ id: "u1", fitUserId: 42 }), "fit:42");
    assert.equal(canvasProjectsOwner({ id: "u1" }), "user:u1");
    const { stored, storage } = memoryStorage();
    assert.equal(readCanvasProjectsOwner(storage), null);
    writeCanvasProjectsOwner("fit:42", storage);
    assert.equal(stored.get(CANVAS_PROJECTS_OWNER_KEY), "fit:42");
    assert.equal(readCanvasProjectsOwner(storage), "fit:42");
    assert.equal(readCanvasProjectsOwner(brokenStorage), null);
    assert.doesNotThrow(() => writeCanvasProjectsOwner("fit:1", brokenStorage));
});

test("the account-switch question names both accounts, says the old keys are gone and running videos cannot be fetched, and tells a stranger what to do", () => {
    const to = { id: 9, displayName: "乙", group: "default" };
    const both = accountSwitchText({ from: "甲", to, keys: true, canvas: true });
    assert.match(both, /openai\.fit 现在登录的是「乙」/);
    assert.match(both, /「甲」的令牌和画布账号/);
    assert.match(both, /还没生成完的视频将无法取回/);
    assert.match(both, /没有登录过「乙」/);
    assert.match(accountSwitchText({ from: "甲", to, keys: true, canvas: false }), /「甲」的令牌/);
    const canvasOnly = accountSwitchText({ from: "甲", to, keys: false, canvas: true });
    assert.match(canvasOnly, /「甲」的画布账号/);
    assert.doesNotMatch(canvasOnly, /视频将无法取回/);
});

test("接线（按源码查）：登录后同步本机画布项目时记下它们属于哪个账号；换账号、同步项目都先问", () => {
    const layout = readFileSync(new URL("../app/(user)/layout.tsx", import.meta.url), "utf8");
    assert.match(layout, /writeCanvasProjectsOwner\(canvasProjectsOwner\(user\)\);\s+void canvasStore\.syncWithRemote\(token, true\);/);
    const component = readFileSync(new URL("../components/layout/fit-bridge.tsx", import.meta.url), "utf8");
    assert.match(component, /accountSwitchText\(accountSwitch\)/);
    assert.match(component, /confirmAccountSwitch\(\)/);
    assert.match(component, /declineAccountSwitch\(\)/);
    assert.match(component, /confirmProjectSync\(\)/);
    assert.match(component, /declineProjectSync\(\)/);
    assert.match(component, /bridgeOpening\(/);
});
