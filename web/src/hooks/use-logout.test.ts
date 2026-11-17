import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";
import { applyFitModels, logoutAsksAboutFitToken, normalizeFitConfig, resetAccountPreferences, withoutFitKeys } from "@/lib/fit-config";
import { classifyFitModels } from "@/lib/fit-models";
import { fitProfileFor, loadFitStudio } from "@/services/api/fit/catalog";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";

const MODELS = [
    { id: "seedance 2.5-GT", supported_endpoint_types: ["openai-video"] },
    { id: "gpt-image-2", supported_endpoint_types: ["image-generation"] },
];
const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const slot = (tokenId: number, apiKey: string) => ({ tokenId, name: `令牌${tokenId}`, group: "", apiKey });
/** 浏览器里存着三把令牌、验证过模型的配置（和自动选好令牌、同步模型之后一样）。 */
const signedIn = (apiKey: string) =>
    applyFitModels({ ...normalizeFitConfig(defaultConfig), fitKeys: { video: slot(1, apiKey), image: slot(2, `${apiKey}-image`), text: slot(3, `${apiKey}-text`) }, fitAccount: { userId: 7, displayName: "叶悠" } }, { list: classifyFitModels(MODELS, null), tokenName: "画布令牌", expiresAt: 99, checkedAt: 5 });
const keysOf = (key: string) => ({ video: key, image: key, text: key });

test("主动退出：浏览器里存着任何一把 openai.fit 令牌（手动或三把之一）才弹确认；没存令牌直接退出", () => {
    assert.equal(logoutAsksAboutFitToken({ fitKeys: {}, fitManualKey: "sk-keep" }), true);
    assert.equal(logoutAsksAboutFitToken({ fitKeys: {}, fitManualKey: "keep" }), true);
    assert.equal(logoutAsksAboutFitToken({ fitKeys: { text: slot(3, "sk-text") }, fitManualKey: "" }), true);
    assert.equal(logoutAsksAboutFitToken({ fitKeys: {}, fitManualKey: "" }), false);
    assert.equal(logoutAsksAboutFitToken({ fitKeys: {}, fitManualKey: "   " }), false);
});

test("选「退出并清除令牌」：令牌、令牌名和模型列表都清掉，退出后重置偏好也不会带回来", () => {
    const cleared = withoutFitKeys({ ...signedIn("sk-public-pc"), fitManualKey: "sk-manual" });
    assert.deepEqual([cleared.fitKeys, cleared.fitManualKey, cleared.fitAccount], [{}, "", undefined]);
    assert.equal(cleared.localChannels[0].apiKey, "");
    assert.deepEqual([cleared.models, cleared.imageModels, cleared.videoModels, cleared.localChannels[0].models], [[], [], [], []]);
    assert.deepEqual([cleared.fitTokenName, cleared.fitTokenExpiresAt, cleared.fitTokenCheckedAt], ["", 0, 0]);
    const afterLogout = resetAccountPreferences(cleared, defaultConfig);
    assert.deepEqual([afterLogout.fitKeys, afterLogout.fitManualKey], [{}, ""]);
    assert.equal(logoutAsksAboutFitToken(afterLogout), false);
});

test("选「仅退出（保留令牌）」、登录过期、被动退出、换账号：都只走 resetAccountPreferences，令牌和模型列表原样保留", () => {
    const config = signedIn("sk-keep-me");
    const reset = resetAccountPreferences(config, defaultConfig);
    assert.deepEqual(reset.fitKeys, config.fitKeys);
    assert.equal(reset.fitKeys.video?.apiKey, "sk-keep-me");
    assert.deepEqual(reset.videoModels, ["seedance 2.5-GT"]);
    assert.equal(reset.fitTokenName, "画布令牌");
});

test("清除令牌同时清掉这把令牌的目录缓存（fitProfileFor 查不到旧卡片，再读要重新请求）和传到 openai.fit 的参考素材地址", async () => {
    const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter, now: Date.now };
    const globals = globalThis as { localStorage?: unknown };
    const hadStorage = "localStorage" in globals;
    const savedStorage = globals.localStorage;
    // fit 生成库把上传过的参考素材地址记在 localStorage 的 generate.hosted-uploads.v1（地址不用令牌就能打开）
    const stored = new Map([["generate.hosted-uploads.v1", '{"owner:image/png:abc":{"url":"https://openai.fit/v1/uploads/abc","expiresAt":1}}']]);
    globals.localStorage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) };
    // 时钟拨到 1 小时后，别的测试文件留下的 60 秒缓存都过期
    Date.now = () => original.now() + 3_600_000;
    let models = 0;
    let catalogs = 0;
    globalThis.fetch = (async () => {
        models += 1;
        return Response.json({ success: true, data: MODELS });
    }) as unknown as typeof fetch;
    const adapter: AxiosAdapter = async (config) => {
        catalogs += 1;
        return { data: { code: 0, data: { pricing: MODELS.map((model) => ({ model_name: model.id, supported_endpoint_types: model.supported_endpoint_types })), capabilities: null }, msg: "" }, status: 200, statusText: "", headers: {}, config };
    };
    axios.defaults.adapter = adapter;
    try {
        useConfigStore.setState({ config: signedIn("sk-logout-cache") });
        await loadFitStudio(keysOf("sk-logout-cache"));
        assert.ok(fitProfileFor("seedance 2.5-GT"));
        assert.deepEqual([models, catalogs], [1, 1]);

        useConfigStore.getState().clearFitKeys();
        assert.deepEqual(useConfigStore.getState().config.fitKeys, {});
        assert.deepEqual(useConfigStore.getState().config.videoModels, []);
        assert.equal(fitProfileFor("seedance 2.5-GT"), null);
        assert.equal(stored.has("generate.hosted-uploads.v1"), false);
        // 60 秒内同一把令牌本来直接用缓存，清掉之后要重新请求
        await loadFitStudio(keysOf("sk-logout-cache"));
        assert.deepEqual([models, catalogs], [2, 2]);
    } finally {
        useConfigStore.getState().clearFitKeys();
        globalThis.fetch = original.fetch;
        axios.defaults.adapter = original.adapter;
        Date.now = original.now;
        if (hadStorage) globals.localStorage = savedStorage;
        else delete globals.localStorage;
    }
});

test("接线（bun 导入 tsx 太慢，按源码查）：两处「退出登录」都走 useLogout；确认框三个选项；三种退出都先记「不要自动登录」；过期、换账号的路径不清令牌", () => {
    const hook = source("./use-logout.tsx");
    // 没存令牌：先记标记再退出
    assert.match(hook, /if \(!logoutAsksAboutFitToken\(useConfigStore\.getState\(\)\.config\)\) \{\s+disableAutoLogin\(\);\s+return clearSession\(\);\s+\}/);
    assert.match(hook, /okText: "退出并清除令牌",/);
    assert.match(hook, /cancelText: "取消",/);
    // 主按钮：记标记、清令牌和目录缓存再退出；次按钮记标记后只退出；取消（含 Esc）不退出、不记标记
    // 「退出并清除令牌」连内存里桥接页取过的密钥缓存、令牌列表和 fit 用户一起清掉（公用电脑）
    assert.match(hook, /onOk: \(\) => \{\s+disableAutoLogin\(\);\s+clearFitKeys\(\);\s+forgetFitSession\(\);\s+queryClient\.removeQueries\(\{ queryKey: \["fit-studio"\] \}\);\s+clearSession\(\);\s+\}/);
    assert.match(hook, /onClick=\{\(\) => \{\s+dialog\.destroy\(\);\s+disableAutoLogin\(\);\s+clearSession\(\);\s+\}\}\s+>\s+仅退出（保留令牌）/);
    assert.equal(hook.match(/disableAutoLogin\(\);/g)?.length, 3);
    assert.doesNotMatch(hook, /onCancel/);
    // 和 useFitProfile 用同一个 queryKey（三把令牌）
    assert.match(source("./use-fit-profile.ts"), /queryKey: \["fit-studio", video, image, text\]/);
    for (const path of ["../components/layout/user-status-actions.tsx", "../app/(admin)/admin/layout.tsx"]) {
        const page = source(path);
        assert.match(page, /const logout = useLogout\(\);/, path);
        assert.doesNotMatch(page, /state\.clearSession/, path);
    }
    // 登录过期、/auth/me 失败、换账号：client-root-init 只重置随账号同步的偏好，令牌保留
    const root = source("../components/layout/client-root-init.tsx");
    assert.match(root, /config: resetAccountPreferences\(state\.config, defaultConfig\)/);
    assert.doesNotMatch(root, /clearFitKeys|withoutFitKeys/);
    assert.match(source("../stores/use-config-store.ts"), /clearFitStudioCache\(\);\r?\n\s+clearHostedUploadCache\(\);\r?\n\s+set\(\(state\) => \(\{ fitTokenError: "", fitKeyErrors: \{\}, config: withoutFitKeys\(state\.config\) \}\)\);/);
});
