import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";
import type { FitCatalog, FitTokenModel } from "@/lib/fit-models";
import { applyFitPricing } from "@/lib/fit-price";
import { fetchFitCatalog, fitProfileFor, loadFitStudio } from "../catalog";

/** /v1/models 返回的令牌模型：价目表里的图片、视频、文本，加上 gpt-6 这类分组文本模型和一个不在价目表里的图片模型。 */
const TOKEN_MODELS: FitTokenModel[] = [
    { id: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"] },
    { id: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"] },
    { id: "mystery-gem", supported_endpoint_types: ["gemini", "openai"] },
    { id: "seedance-2.0-mini-super", supported_endpoint_types: ["openai-video"] },
    { id: "seedance-2.0-fast-deal", supported_endpoint_types: ["openai-video"] },
    { id: "seedance 2.0 OvO", supported_endpoint_types: ["openai-video"] },
    { id: "claude-sonnet-5", supported_endpoint_types: ["anthropic", "openai"] },
    { id: "gpt-6-astra", supported_endpoint_types: ["openai", "openai-response"] },
    { id: "group-only-image", supported_endpoint_types: ["image-generation"] },
];

/** 字段取自 2026-11-01 openai.fit 的 /api/pricing 和 /api/model-capabilities（只保留用到的）。 */
const CATALOG: FitCatalog = {
    pricing: [
        { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"], tags: "图像生成,GPT Image" },
        { model_name: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" },
        { model_name: "mystery-gem", supported_endpoint_types: ["gemini", "openai"], tags: "" },
        { model_name: "seedance-2.0-mini-super", supported_endpoint_types: ["openai-video"], tags: "视频生成,Seedance", billing_usage_schema: { resolution: { enum: ["480p", "720p", "1080p"] } } },
        { model_name: "seedance-2.0-fast-deal", supported_endpoint_types: ["openai-video"], tags: "视频生成,Seedance", billing_usage_schema: { resolution: { enum: ["480p", "720p", "1080p"] } } },
        { model_name: "seedance 2.0 OvO", supported_endpoint_types: ["openai-video"], tags: "视频生成,Seedance", billing_usage_schema: { resolution: { enum: ["720p"] } } },
        { model_name: "claude-sonnet-5", supported_endpoint_types: ["anthropic", "openai"], tags: "" },
    ],
    capabilities: {
        schemaVersion: 1,
        revision: "r-20261101",
        models: [
            { id: "gpt-image-2", kind: "image", family: "openai-image", available: true, visible: true },
            { id: "gemini-nano-banana-2.1", kind: "image", family: "gemini-image", available: true, visible: true },
            { id: "mystery-gem", kind: "image", family: "gemini-image", available: true, visible: true },
            { id: "seedance-2.0-mini-super", kind: "video", family: "url-lists", available: true, visible: true },
            { id: "seedance-2.0-fast-deal", kind: "video", family: "url-lists", available: false, visible: true },
            { id: "seedance 2.0 OvO", kind: "video", family: "unsupported", available: false, visible: true },
        ],
    },
    fetchedAt: 1_793_500_000,
    stale: false,
};

let clock = Date.now();

type Calls = { models: number; catalog: number; authorization: string[]; credentials: string[] };

/** 每个用例把时钟拨快 2 分钟（两层 60 秒缓存都过期），并接管 /v1/models 的 fetch 和 /api/fit/catalog 的 axios。 */
async function withFit(catalog: FitCatalog | null, run: (calls: Calls) => Promise<void>, token: Response | null = null) {
    const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter, now: Date.now };
    clock += 120_000;
    Date.now = () => clock;
    const calls: Calls = { models: 0, catalog: 0, authorization: [], credentials: [] };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "https://openai.fit/v1/models");
        calls.models += 1;
        calls.authorization.push(new Headers(init?.headers).get("Authorization") || "");
        calls.credentials.push(String(init?.credentials));
        return token?.clone() ?? Response.json({ success: true, object: "list", data: TOKEN_MODELS });
    }) as typeof fetch;
    const adapter: AxiosAdapter = async (config) => {
        assert.equal(config.url, "/api/fit/catalog");
        calls.catalog += 1;
        const data = catalog ? { code: 0, data: catalog, msg: "" } : { code: 1, data: null, msg: "openai.fit 目录暂时拿不到" };
        return { data, status: catalog ? 200 : 502, statusText: "", headers: {}, config };
    };
    axios.defaults.adapter = adapter;
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original.fetch;
        axios.defaults.adapter = original.adapter;
        Date.now = original.now;
    }
}

const keysOf = (key: string) => ({ video: key, image: key, text: key });
const sorted = (models: string[]) => [...models].sort((a, b) => a.localeCompare(b));

test("文本模型不被价目表过滤；图片和视频要在价目表里并且能建出 fit 的 profile；能力目录停售或占位的不显示", async () => {
    await withFit(CATALOG, async (calls) => {
        const list = await loadFitStudio(keysOf("sk-catalog-a"));
        assert.deepEqual(list.models, sorted(["claude-sonnet-5", "gemini-nano-banana-2.1", "gpt-6-astra", "gpt-image-2", "seedance-2.0-mini-super"]));
        assert.deepEqual(list.counts, { text: 2, image: 2, video: 1, audio: 0 });
        assert.deepEqual(sorted(Object.keys(list.profiles)), sorted(["gemini-nano-banana-2.1", "gpt-image-2", "seedance-2.0-mini-super"]));
        assert.equal(fitProfileFor("seedance-2.0-mini-super")?.referenceMode, "url-lists");
        assert.equal(fitProfileFor("gemini-nano-banana-2.1")?.imageApi, "gemini-image");
        assert.equal(fitProfileFor("gpt-6-astra"), null);
        assert.equal(fitProfileFor("seedance-2.0-fast-deal"), null);
        assert.equal(fitProfileFor("toString"), null);
        assert.deepEqual(calls.authorization, ["Bearer sk-catalog-a"]);
        assert.deepEqual(calls.credentials, ["omit"]);
    });
});

test("目录带上计价字段、分组倍率和币种设置：模型列表照旧，价格按 fit 的价格库算", async () => {
    const priced: FitCatalog = {
        ...CATALOG,
        pricing: CATALOG.pricing.map((entry) => (entry.model_name === "seedance-2.0-mini-super" ? { ...entry, quota_type: 0, enable_groups: ["default"], billing_mode: "tiered_expr", billing_expr: 'tier("按次", 0.1095890410958904)' } : entry)),
        groupRatio: { default: 1 },
        status: { price: 7.3, usd_exchange_rate: 7.3, quota_display_type: "CNY" },
    };
    await withFit(priced, async () => {
        const list = await loadFitStudio(keysOf("sk-catalog-price"));
        assert.equal(list.profiles["seedance-2.0-mini-super"].referenceMode, "url-lists");
        const catalog = await fetchFitCatalog();
        assert.deepEqual(catalog.status, priced.status);
        const pricing = applyFitPricing(catalog);
        assert.equal(pricing.models.get("seedance-2.0-mini-super")?.billing_expr, 'tier("按次", 0.1095890410958904)');
        assert.deepEqual(pricing.models.get("gpt-image-2")?.group_ratio, { default: 1 });
    });
});

test("能力目录拿不到时退回打包的规则：审核过的卡照旧，停售和占位的不再被目录拦下", async () => {
    await withFit({ ...CATALOG, capabilities: null }, async () => {
        const list = await loadFitStudio(keysOf("sk-catalog-b"));
        assert.deepEqual(list.models, sorted(["claude-sonnet-5", "gemini-nano-banana-2.1", "gpt-6-astra", "gpt-image-2", "mystery-gem", "seedance 2.0 OvO", "seedance-2.0-fast-deal", "seedance-2.0-mini-super"]));
        // 没有能力目录的 kind，gemini 接口、标签和名字都不像图片的模型按文本算
        assert.equal(list.modelCapabilities["mystery-gem"], "text");
        assert.equal(list.profiles["seedance-2.0-mini-super"].referenceMode, "url-lists");
        assert.deepEqual(list.profiles["seedance-2.0-mini-super"].seconds, { mode: "fixed", value: 15 });
    });
});

test("整个目录接口失败时不卡住：文本照常显示，图片和视频按接口类型和打包的规则建 profile", async () => {
    await withFit(null, async () => {
        const list = await loadFitStudio(keysOf("sk-catalog-c"));
        assert.equal(list.modelCapabilities["gemini-nano-banana-2.1"], "image");
        assert.equal(list.modelCapabilities["group-only-image"], "image");
        assert.equal(list.modelCapabilities["gpt-6-astra"], "text");
        assert.equal(list.modelCapabilities["seedance-2.0-mini-super"], "video");
        assert.equal(list.profiles["seedance-2.0-mini-super"].referenceMode, "url-lists");
    });
});

test("同一把令牌 60 秒内只请求一次，换令牌重新请求；目录在 60 秒内共用", async () => {
    await withFit(CATALOG, async (calls) => {
        const first = await loadFitStudio(keysOf("sk-catalog-d"));
        assert.equal(await loadFitStudio(keysOf("catalog-d")), first);
        assert.deepEqual([calls.models, calls.catalog], [1, 1]);
        await loadFitStudio(keysOf("sk-catalog-e"));
        assert.deepEqual([calls.models, calls.catalog], [2, 1]);
        clock += 61_000;
        await loadFitStudio(keysOf("sk-catalog-e"));
        assert.deepEqual([calls.models, calls.catalog], [3, 2]);
    });
});

test("令牌无效时报 fit 的原因，失败不缓存", async () => {
    await withFit(
        CATALOG,
        async (calls) => {
            await assert.rejects(loadFitStudio(keysOf("sk-catalog-bad")), /无效的令牌/);
            await assert.rejects(loadFitStudio(keysOf("sk-catalog-bad")), /无效的令牌/);
            assert.equal(calls.models, 2);
        },
        Response.json({ error: { message: "无效的令牌", type: "new_api_error" } }, { status: 401 }),
    );
});

test("三把令牌按类型合并：视频（连同卡片）只取视频令牌的、图片只取图片令牌的、文本和语音只取文本令牌的；一把失败不影响另外两把", async () => {
    const byKey: Record<string, FitTokenModel[] | null> = {
        "sk-merge-video": [TOKEN_MODELS[3], TOKEN_MODELS[6], { id: "tts-from-video", supported_endpoint_types: ["openai"] }],
        "sk-merge-image": [TOKEN_MODELS[0], TOKEN_MODELS[3]],
        "sk-merge-text": [TOKEN_MODELS[7], { id: "tts-1", supported_endpoint_types: ["openai"] }, TOKEN_MODELS[0]],
        "sk-merge-bad": null,
    };
    await withFit(CATALOG, async (calls) => {
        const original = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const key = (new Headers(init?.headers).get("Authorization") || "").replace(/^Bearer /, "");
            calls.models += 1;
            calls.authorization.push(key);
            const models = byKey[key];
            return models ? Response.json({ success: true, data: models }) : Response.json({ error: { message: "无效的令牌" } }, { status: 401 });
        }) as typeof fetch;
        try {
            const list = await loadFitStudio({ video: "sk-merge-video", image: "sk-merge-image", text: "sk-merge-text" });
            assert.deepEqual(list.models, sorted(["seedance-2.0-mini-super", "gpt-image-2", "gpt-6-astra", "tts-1"]));
            assert.deepEqual(list.modelCapabilities, { "seedance-2.0-mini-super": "video", "gpt-image-2": "image", "gpt-6-astra": "text", "tts-1": "audio" });
            assert.deepEqual(sorted(Object.keys(list.profiles)), ["gpt-image-2", "seedance-2.0-mini-super"]);
            assert.deepEqual(list.counts, { text: 1, image: 1, video: 1, audio: 1 });
            assert.deepEqual(list.errors, {});
            assert.deepEqual(sorted(calls.authorization), ["sk-merge-image", "sk-merge-text", "sk-merge-video"]);

            // 同一把令牌只请求一次；文本令牌无效时视频、图片照常，文本的原因单独给出
            calls.authorization.length = 0;
            const partial = await loadFitStudio({ video: "sk-merge-video", image: "sk-merge-video", text: "sk-merge-bad" });
            assert.deepEqual(sorted(calls.authorization), ["sk-merge-bad", "sk-merge-video"]);
            assert.deepEqual(partial.models, ["seedance-2.0-mini-super"]);
            assert.deepEqual(partial.errors, { text: "无效的令牌" });
            // 全部失败才报错
            await assert.rejects(loadFitStudio({ video: "sk-merge-bad", image: "", text: "" }), /无效的令牌/);
            await assert.rejects(loadFitStudio({ video: "", image: "", text: "" }), /缺少可用的模型服务令牌/);
        } finally {
            globalThis.fetch = original;
        }
    });
});
