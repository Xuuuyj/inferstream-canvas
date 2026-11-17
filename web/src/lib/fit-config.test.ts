import assert from "node:assert/strict";
import test from "node:test";
import {
    applyFitModels,
    fitChannel,
    fitKeyFor,
    fitKeyForModel,
    fitKeyForRef,
    fitKeyRef,
    fitKeySet,
    fitKeysComplete,
    fitKeyStatusLabel,
    fitKindOfModel,
    fitModelsStale,
    FIT_MODELS_STALE_MS,
    hasAnyFitKey,
    isFitConfig,
    logoutAsksAboutFitToken,
    migrateFitKeys,
    hasBridgeFitKeys,
    hasLegacyStoredKey,
    withoutBridgeFitKeys,
    normalizeFitApiKey,
    normalizeFitConfig,
    resetAccountPreferences,
    stripSecretsForSync,
    syncedPreferences,
    SYNC_SECRET_KEYS,
    withFitKeySlot,
    withFitManualKey,
} from "./fit-config";
import { classifyFitModels } from "./fit-models";
import { defaultConfig, localChannelForActiveModel, normalizeLocalChannels, type AiConfig, type FitKeySlot } from "@/stores/use-config-store";

const VIDEO_KEY = "sk-video-0123456789abcdef";
const IMAGE_KEY = "sk-image-0123456789abcdef";
const TEXT_KEY = "sk-text-0123456789abcdefg";
const slot = (tokenId: number, apiKey: string, name = `令牌${tokenId}`): FitKeySlot => ({ tokenId, name, group: "", apiKey });
const threeKeys = { video: slot(1, VIDEO_KEY), image: slot(2, IMAGE_KEY), text: slot(3, TEXT_KEY) };

function legacyConfig() {
    return {
        channelMode: "remote",
        baseUrl: "https://api.example.com",
        fitKeys: {},
        fitManualKey: "",
        model: "gpt-image-2",
        imageModel: "gpt-image-2",
        videoModel: "old-video",
        textModel: "old-text",
        audioModel: "",
        models: ["m1", "m2", "m3"],
        imageModels: [],
        videoModels: [],
        textModels: [],
        audioModels: [],
        localChannels: [
            { id: "local-1", protocol: "openai", name: "A", baseUrl: "https://a.example", apiKey: "sk-a", models: ["m1"] },
            { id: "local-2", protocol: "gemini", name: "B", baseUrl: "https://b.example", apiKey: "sk-b", models: ["m2"] },
            { id: "local-3", protocol: "runninghub", name: "C", baseUrl: "https://c.example", apiKey: "sk-c", models: ["m3"], uploadApiKey: "up-c" },
        ],
        publicChannels: [{ id: "cloud", protocol: "openai", name: "云端", baseUrl: "https://cloud.example", models: ["m4"] }],
        activeChannelId: "local-2",
        imageChannelId: "local-1",
        videoChannelId: "local-2",
        textChannelId: "cloud",
        audioChannelId: "",
    } as unknown as AiConfig;
}

const MIXED = classifyFitModels(
    [
        { id: "seedance", supported_endpoint_types: ["openai-video"] },
        { id: "gpt-image-2", supported_endpoint_types: ["image-generation"] },
        { id: "claude", supported_endpoint_types: ["anthropic"] },
        { id: "tts-1", supported_endpoint_types: ["openai"] },
    ],
    null,
);

test("legacy persisted data normalizes to the single openai.fit channel, which never stores a key", () => {
    const config = normalizeFitConfig(legacyConfig());
    assert.equal(config.channelMode, "local");
    assert.equal(config.baseUrl, "https://openai.fit");
    assert.deepEqual(config.publicChannels, []);
    assert.deepEqual(config.localChannels, [{ id: "openai-fit", protocol: "openai", name: "openai.fit", baseUrl: "https://openai.fit", apiKey: "", models: [], modelCapabilities: {} }]);
    assert.deepEqual(config.models, []);
    for (const key of ["activeChannelId", "imageChannelId", "videoChannelId", "textChannelId", "audioChannelId"] as const) assert.equal(config[key], "openai-fit", key);
});

test("the fit channel keeps only the models saved on the fit channel itself and drops a stale saved key", () => {
    const channel = fitChannel({ localChannels: [{ id: "openai-fit", protocol: "openai", name: "x", baseUrl: "https://elsewhere", apiKey: "sk-stale", models: ["a", ""], modelCapabilities: { a: "text" } }] });
    assert.deepEqual(channel, { id: "openai-fit", protocol: "openai", name: "openai.fit", baseUrl: "https://openai.fit", apiKey: "", models: ["a"], modelCapabilities: { a: "text" } });
});

test("fitKeyFor: the manual key wins for every kind; otherwise each kind uses its own slot", () => {
    assert.deepEqual(fitKeySet({ fitKeys: threeKeys, fitManualKey: "" }), { video: VIDEO_KEY, image: IMAGE_KEY, text: TEXT_KEY });
    assert.deepEqual(fitKeySet({ fitKeys: threeKeys, fitManualKey: " manual-key " }), { video: "sk-manual-key", image: "sk-manual-key", text: "sk-manual-key" });
    assert.deepEqual(fitKeySet({ fitKeys: { video: threeKeys.video }, fitManualKey: "   " }), { video: VIDEO_KEY, image: "", text: "" });
    assert.equal(fitKeyFor({}, "text"), "");
});

test("fitKindOfModel: synced capabilities first (audio counts as text), then fit's name rules", () => {
    const config = applyFitModels(normalizeFitConfig(legacyConfig()), { list: MIXED });
    assert.equal(config.localChannels[0].modelCapabilities?.["tts-1"], "audio");
    assert.deepEqual(["seedance", "gpt-image-2", "claude", "tts-1"].map((model) => fitKindOfModel(config, model)), ["video", "image", "text", "text"]);
    // 没同步过的模型按名字：视频、图片认得出，其余（包括语音）归文本
    assert.deepEqual(["wan3.0-video", "nano-banana-pro", "gpt-6-astra", "gpt-4o-mini-tts", "toString"].map((model) => fitKindOfModel({}, model)), ["video", "image", "text", "text", "text"]);
    const keyed = { ...config, fitKeys: threeKeys };
    assert.deepEqual(["seedance", "gpt-image-2", "claude", "tts-1"].map((model) => fitKeyForModel(keyed, model)), [VIDEO_KEY, IMAGE_KEY, TEXT_KEY, TEXT_KEY]);
});

test("the effective channel's key follows the active model's kind, so every request helper picks the matching key", () => {
    const config = { ...applyFitModels(normalizeFitConfig(legacyConfig()), { list: MIXED }), fitKeys: threeKeys };
    for (const [model, key] of [["seedance", VIDEO_KEY], ["gpt-image-2", IMAGE_KEY], ["claude", TEXT_KEY], ["tts-1", TEXT_KEY]] as const) {
        assert.equal(normalizeLocalChannels({ ...config, model })[0].apiKey, key, model);
        assert.equal(localChannelForActiveModel({ ...config, model })?.apiKey, key, model);
    }
    assert.equal(localChannelForActiveModel({ ...config, model: "claude", fitManualKey: "sk-manual-0123456789abc" })?.apiKey, "sk-manual-0123456789abc");
    // 存下来的渠道里没有密钥
    assert.equal(config.localChannels[0].apiKey, "");
});

test("fitKeyRef records which key a task used; fitKeyForRef finds it again, then falls back to the manual key, then the video key", () => {
    assert.equal(fitKeyRef({ fitKeys: threeKeys, fitManualKey: "" }, "video"), "t:1");
    assert.equal(fitKeyRef({ fitKeys: threeKeys, fitManualKey: "sk-m" }, "video"), "manual");
    assert.equal(fitKeyRef({ fitKeys: {}, fitManualKey: "" }, "video"), "");
    // 视频槽位换成了别的令牌，提交时那把（id 2）还在图片槽位：照样用它
    assert.equal(fitKeyForRef({ fitKeys: { video: slot(9, "sk-new-video-0123456789"), image: slot(2, IMAGE_KEY) }, fitManualKey: "" }, "t:2"), IMAGE_KEY);
    assert.equal(fitKeyForRef({ fitKeys: threeKeys, fitManualKey: "manual-key" }, "t:7"), "sk-manual-key");
    assert.equal(fitKeyForRef({ fitKeys: threeKeys, fitManualKey: "" }, "t:7"), VIDEO_KEY);
    assert.equal(fitKeyForRef({ fitKeys: threeKeys, fitManualKey: "" }, "manual"), VIDEO_KEY);
    assert.equal(fitKeyForRef({ fitKeys: threeKeys, fitManualKey: "" }, undefined), VIDEO_KEY);
    assert.equal(fitKeyForRef({ fitKeys: {}, fitManualKey: "" }, "t:1"), "");
});

test("fitKeysComplete and hasAnyFitKey: one manual key counts for all three", () => {
    assert.equal(fitKeysComplete({ fitKeys: threeKeys, fitManualKey: "" }), true);
    assert.equal(fitKeysComplete({ fitKeys: { video: threeKeys.video, image: threeKeys.image }, fitManualKey: "" }), false);
    assert.equal(fitKeysComplete({ fitKeys: {}, fitManualKey: "sk-only" }), true);
    assert.equal(hasAnyFitKey({ fitKeys: { text: threeKeys.text }, fitManualKey: "" }), true);
    assert.equal(hasAnyFitKey({ fitKeys: {}, fitManualKey: "  " }), false);
});

test("fitModelsStale: a synced list older than 10 minutes is pulled again; never-synced and keyless configs are left alone", () => {
    const now = 1_800_000_000_000;
    assert.equal(fitModelsStale({ fitKeys: threeKeys, fitManualKey: "", fitTokenCheckedAt: now - FIT_MODELS_STALE_MS }, now), true);
    assert.equal(fitModelsStale({ fitKeys: threeKeys, fitManualKey: "", fitTokenCheckedAt: now - FIT_MODELS_STALE_MS + 1 }, now), false);
    assert.equal(fitModelsStale({ fitKeys: {}, fitManualKey: "sk-only", fitTokenCheckedAt: now - 86_400_000 }, now), true);
    assert.equal(fitModelsStale({ fitKeys: threeKeys, fitManualKey: "", fitTokenCheckedAt: 0 }, now), false);
    assert.equal(fitModelsStale({ fitKeys: {}, fitManualKey: "", fitTokenCheckedAt: now - 86_400_000 }, now), false);
});

test("a previous version's single apiKey becomes the manual key; malformed slots are dropped", () => {
    const legacy = { ...defaultConfig, apiKey: " legacy-key-0123456789 ", fitManualKey: undefined, fitKeys: undefined } as unknown as Partial<AiConfig> & { apiKey: string };
    assert.deepEqual(migrateFitKeys(legacy), { fitKeys: {}, fitManualKey: "sk-legacy-key-0123456789", fitAccount: undefined });
    // 结果里根本没有 apiKey 这个字段（不是 undefined），合进配置后旧字段就没了
    assert.equal(Object.hasOwn(migrateFitKeys(legacy), "apiKey"), false);
    // 手动令牌已经有值时不被旧值覆盖
    assert.equal(migrateFitKeys({ ...legacy, fitManualKey: "sk-current" }).fitManualKey, "sk-current");
    const migrated = migrateFitKeys({
        fitKeys: { video: slot(5, VIDEO_KEY), image: { tokenId: 0, name: "x", group: "", apiKey: IMAGE_KEY }, text: { tokenId: 6, name: "x", group: "", apiKey: "not-a-key" } },
        fitAccount: { userId: 42, displayName: "叶悠" },
    });
    assert.deepEqual(migrated.fitKeys, { video: slot(5, VIDEO_KEY) });
    assert.deepEqual(migrated.fitAccount, { userId: 42, displayName: "叶悠" });
    assert.equal(migrateFitKeys({ fitAccount: { userId: -1, displayName: "x" } }).fitAccount, undefined);
    assert.deepEqual(migrateFitKeys({ fitAccount: { userId: 42, displayName: "叶悠", checkedAt: 1_800_000_000_000 } }).fitAccount, { userId: 42, displayName: "叶悠", checkedAt: 1_800_000_000_000 });
});

test("a new manual key or slot clears the old sync status; the same key is a no-op", () => {
    const synced = applyFitModels({ ...normalizeFitConfig(legacyConfig()), fitManualKey: "sk-old" }, { list: MIXED, tokenName: "旧令牌", checkedAt: 1 });
    const next = withFitManualKey(synced, "sk-new");
    assert.equal(next.fitManualKey, "sk-new");
    assert.deepEqual([next.fitTokenName, next.fitTokenCheckedAt], ["", 0]);
    assert.equal(withFitManualKey(next, "sk-new"), next);
    const slotted = withFitKeySlot({ ...synced, fitTokenCheckedAt: 5 }, "video", threeKeys.video);
    assert.deepEqual([slotted.fitKeys.video, slotted.fitTokenCheckedAt], [threeKeys.video, 0]);
    assert.equal(withFitKeySlot({ ...slotted, fitTokenCheckedAt: 7 }, "video", { ...threeKeys.video, name: "改名" }).fitTokenCheckedAt, 7);
    assert.equal(withFitKeySlot(slotted, "video", null).fitKeys.video, undefined);
});

test("normalizeFitApiKey adds the sk- prefix and trims", () => {
    assert.equal(normalizeFitApiKey(" abc "), "sk-abc");
    assert.equal(normalizeFitApiKey("sk-abc"), "sk-abc");
    assert.equal(normalizeFitApiKey(""), "");
});

test("isFitConfig recognizes the fit channel id or base URL", () => {
    assert.equal(isFitConfig({ activeChannelId: "openai-fit" }), true);
    assert.equal(isFitConfig({ localChannels: [fitChannel({})] }), true);
    assert.equal(isFitConfig({ baseUrl: "https://openai.fit/v1" }), true);
    assert.equal(isFitConfig({ baseUrl: "https://api.openai.com", activeChannelId: "local-1" }), false);
});

function collectKeys(value: unknown, keys = new Set<string>()) {
    if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
    else if (value && typeof value === "object")
        for (const [key, item] of Object.entries(value)) {
            keys.add(key);
            collectKeys(item, keys);
        }
    return keys;
}

test("stripSecretsForSync removes every C20 field at any depth, including the three keys, the manual key and the fit account", () => {
    const payload = { ...legacyConfig(), fitKeys: threeKeys, fitManualKey: "sk-manual", fitAccount: { userId: 42, displayName: "叶悠" }, channelTranslations: [{ channelId: "local-1", source: "x" }], workflowChannels: [{ channelId: "w", apiKey: "sk-w", uploadApiKey: "up", baseUrl: "https://w", nested: [{ apiKey: "sk-deep" }] }] };
    const stripped = stripSecretsForSync(payload);
    const keys = collectKeys(stripped);
    for (const key of SYNC_SECRET_KEYS) assert.equal(keys.has(key), false, key);
    for (const key of ["fitKeys", "fitManualKey", "fitAccount"]) assert.equal(keys.has(key), false, key);
    assert.doesNotMatch(JSON.stringify(stripped), /sk-/);
    assert.equal(keys.has("imageModel"), true);
    assert.equal(keys.has("nested"), true);
    assert.equal(payload.fitManualKey, "sk-manual");
});

test("syncedPreferences keeps preferences and never restores tokens, channels or model lists", () => {
    const prefs = syncedPreferences({ ...legacyConfig(), fitKeys: threeKeys, fitManualKey: "sk-m", fitAccount: { userId: 1, displayName: "x" }, fitTokenName: "x", workflowSyncTouched: true, workflowChannels: [], systemPrompt: "hi" });
    assert.deepEqual(Object.keys(prefs).sort(), ["audioModel", "imageModel", "model", "systemPrompt", "textModel", "videoModel"]);
});

test("logging out asks about clearing keys whenever any key (manual or slot) is stored", () => {
    assert.equal(logoutAsksAboutFitToken({ fitKeys: {}, fitManualKey: "keep" }), true);
    assert.equal(logoutAsksAboutFitToken({ fitKeys: { image: threeKeys.image }, fitManualKey: "" }), true);
    assert.equal(logoutAsksAboutFitToken({ fitKeys: {}, fitManualKey: "  " }), false);
});

test("the top bar key button reads 手动令牌 / 令牌已就绪 / 令牌待同步 / 未连接 / 模型服务未连接 / 令牌未选全", () => {
    const base = { fitKeys: {}, fitManualKey: "", fitTokenCheckedAt: 0 };
    const bridge = { autoLoginOff: false, fitLoggedIn: null };
    assert.equal(fitKeyStatusLabel({ ...base, fitManualKey: "sk-m" }, bridge), "手动令牌");
    assert.equal(fitKeyStatusLabel({ ...base, fitKeys: threeKeys, fitTokenCheckedAt: 1 }, bridge), "令牌已就绪");
    assert.equal(fitKeyStatusLabel({ ...base, fitKeys: threeKeys }, bridge), "令牌待同步");
    assert.equal(fitKeyStatusLabel(base, { autoLoginOff: true, fitLoggedIn: null }), "未连接");
    assert.equal(fitKeyStatusLabel(base, { autoLoginOff: false, fitLoggedIn: false }), "模型服务未连接");
    assert.equal(fitKeyStatusLabel({ ...base, fitKeys: { video: threeKeys.video } }, { autoLoginOff: false, fitLoggedIn: false }), "令牌未选全");
});

test("resetAccountPreferences keeps the browser's keys, channel and model lists and resets only synced preferences", () => {
    const defaults = { ...normalizeFitConfig({ ...legacyConfig(), localChannels: [], models: [] }), imageModel: "gpt-image-2", videoModel: "grok-imagine-video", textModel: "gpt-5.5", audioModel: "gpt-4o-mini-tts", systemPrompt: "", timeout: "600", syncStorageConfig: false };
    const list = classifyFitModels([{ id: "gpt-image-2", supported_endpoint_types: ["image-generation"] }, { id: "seedance", supported_endpoint_types: ["openai-video"] }, { id: "claude", supported_endpoint_types: ["anthropic"] }], null);
    const signedIn = { ...applyFitModels({ ...normalizeFitConfig(legacyConfig()), fitKeys: threeKeys, fitManualKey: "sk-keep", fitAccount: { userId: 42, displayName: "叶悠" } }, { list, tokenName: "画布令牌", expiresAt: 99, checkedAt: 5 }), systemPrompt: "账号偏好", timeout: "30", syncStorageConfig: true };
    const reset = resetAccountPreferences(signedIn, defaults);
    assert.deepEqual([reset.fitKeys, reset.fitManualKey, reset.fitAccount], [threeKeys, "sk-keep", { userId: 42, displayName: "叶悠" }]);
    assert.deepEqual(reset.localChannels, signedIn.localChannels);
    assert.deepEqual([reset.models, reset.imageModels, reset.videoModels, reset.textModels], [signedIn.models, ["gpt-image-2"], ["seedance"], ["claude"]]);
    assert.deepEqual([reset.fitTokenName, reset.fitTokenExpiresAt, reset.fitTokenCheckedAt], ["画布令牌", 99, 5]);
    assert.deepEqual([reset.systemPrompt, reset.timeout, reset.syncStorageConfig], ["", "600", false]);
    assert.deepEqual([reset.imageModel, reset.videoModel, reset.textModel, reset.audioModel], ["gpt-image-2", "seedance", "claude", "gpt-4o-mini-tts"]);
});

test("chat/completions and canvas-agent requests (aiHeaders) carry the text key for a text model and nothing for other hosts", async () => {
    const { aiHeaders: headersOf } = await import("@/services/api/image");
    const aiHeaders = (config: AiConfig, target: string) => headersOf(config, target) as Record<string, string | undefined>;
    const config = { ...applyFitModels(normalizeFitConfig({ ...defaultConfig, ...legacyConfig() }), { list: MIXED }), fitKeys: threeKeys };
    assert.equal(aiHeaders({ ...config, model: "claude" }, "https://openai.fit/v1/chat/completions").Authorization, `Bearer ${TEXT_KEY}`);
    assert.equal(aiHeaders({ ...config, model: "gpt-image-2" }, "https://openai.fit/v1/images/generations").Authorization, `Bearer ${IMAGE_KEY}`);
    assert.equal(aiHeaders({ ...config, model: "claude" }, "/api/v1/chat/completions").Authorization, undefined);
    assert.equal(aiHeaders({ ...config, model: "claude", fitKeys: { video: threeKeys.video } }, "https://openai.fit/v1/chat/completions").Authorization, undefined);
});

test("接线（按源码查）：工作流 Agent 起草请求发给画布服务器，请求体里不带令牌和渠道地址", async () => {
    const { readFileSync } = await import("node:fs");
    const workspace = readFileSync(new URL("../components/workflows/creative-workflow-workspace.tsx", import.meta.url), "utf8");
    const draft = workspace.slice(workspace.indexOf("draftUserWorkflow<"), workspace.indexOf("setAgentDraft(normalizeAgentDraft"));
    assert.ok(draft.length > 0);
    assert.doesNotMatch(draft, /apiKey|baseUrl/);
    const api = readFileSync(new URL("../services/api/user-config.ts", import.meta.url), "utf8");
    const payload = api.slice(api.indexOf("export async function draftUserWorkflow"), api.indexOf("/api/v1/workflows/agent-draft"));
    assert.doesNotMatch(payload, /apiKey|baseUrl/);
});

test("a stored legacy key (top-level apiKey or one left in a saved channel) is detected so the store rewrites it right after loading", () => {
    assert.equal(hasLegacyStoredKey({ apiKey: "sk-old-0123456789abcdef" } as never), true);
    assert.equal(hasLegacyStoredKey({ localChannels: [{ id: "fit", apiKey: "sk-old-0123456789abcdef" }] } as never), true);
    assert.equal(hasLegacyStoredKey({ apiKey: "  ", localChannels: [{ id: "fit", apiKey: "" }] } as never), false);
    assert.equal(hasLegacyStoredKey({}), false);
});

test("keys the bridge picked are told apart from a manual key; dropping them keeps the manual key", () => {
    const account = { userId: 7, displayName: "叶悠" };
    assert.equal(hasBridgeFitKeys({ fitKeys: { video: slot(1, VIDEO_KEY) }, fitAccount: account }), true);
    assert.equal(hasBridgeFitKeys({ fitKeys: { video: slot(1, VIDEO_KEY) } }), false);
    assert.equal(hasBridgeFitKeys({ fitKeys: {}, fitAccount: account }), false);
    const withManual = withoutBridgeFitKeys({ ...normalizeFitConfig(defaultConfig), fitKeys: { video: slot(1, VIDEO_KEY) }, fitAccount: account, fitManualKey: "sk-manual-0123456789abc" });
    assert.deepEqual([withManual.fitKeys, withManual.fitAccount, withManual.fitManualKey], [{}, undefined, "sk-manual-0123456789abc"]);
    const bridgeOnly = withoutBridgeFitKeys({ ...normalizeFitConfig(defaultConfig), fitKeys: { video: slot(1, VIDEO_KEY) }, fitAccount: account, fitTokenCheckedAt: 5 });
    assert.deepEqual([bridgeOnly.fitKeys, bridgeOnly.fitAccount, bridgeOnly.fitManualKey, bridgeOnly.fitTokenCheckedAt], [{}, undefined, "", 0]);
});
