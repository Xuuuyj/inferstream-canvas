import assert from "node:assert/strict";
import test from "node:test";

const LEGACY_KEY = "sk-legacy-plaintext-0123456789";
const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

test("a previous version's plaintext key is rewritten out of localStorage right after loading, not at the next settings change", async () => {
    const stored = new Map<string, string>([
        [CONFIG_STORE_KEY, JSON.stringify({ state: { config: { apiKey: LEGACY_KEY, localChannels: [{ id: "openai-fit", protocol: "openai", name: "openai.fit", baseUrl: "https://openai.fit", apiKey: LEGACY_KEY, models: ["gpt-image-2"] }] } }, version: 0 })],
    ]);
    // zustand persist 默认读 window.localStorage
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    const saved = globals.window;
    globals.window = { localStorage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value), removeItem: (key: string) => void stored.delete(key) } };
    try {
        // 单独一份 store 实例：模块创建时从上面这份 localStorage 读配置
        const fresh = "./use-config-store.ts?legacy-rewrite";
        const { useConfigStore } = (await import(fresh)) as typeof import("./use-config-store");
        for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));

        const config = useConfigStore.getState().config as unknown as Record<string, unknown>;
        assert.equal(Object.hasOwn(config, "apiKey"), false, "no apiKey field left in memory");
        assert.equal(useConfigStore.getState().config.fitManualKey, LEGACY_KEY);
        const rewritten = JSON.parse(stored.get(CONFIG_STORE_KEY) || "{}").state.config;
        assert.equal(Object.hasOwn(rewritten, "apiKey"), false);
        assert.equal(rewritten.localChannels[0].apiKey, "");
        assert.equal(rewritten.fitManualKey, LEGACY_KEY);
    } finally {
        if (hadWindow) globals.window = saved;
        else delete globals.window;
    }
});
