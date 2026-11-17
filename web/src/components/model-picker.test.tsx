import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FitPrice, ModelPicker } from "@/components/model-picker";
import type { FitCatalog, FitPricingEntry } from "@/lib/fit-models";
import { applyFitPricing, fitTokenPriceText, type FitPricing } from "@/lib/fit-price";
import { FIT_CHANNEL_ID, FIT_ORIGIN } from "@/lib/model-channel";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

const SECOND = { type: "number", unit: "second" } as const;
const task = (model_name: string, billing_expr: string, resolutions?: string[]): FitPricingEntry => ({
    model_name,
    supported_endpoint_types: ["openai-video"],
    quota_type: 0,
    model_ratio: 37.5,
    completion_ratio: 1,
    model_price: 0,
    enable_groups: ["default", "vip"],
    billing_mode: "tiered_expr",
    billing_expr,
    billing_usage_schema: { ...(resolutions ? { resolution: { enum: resolutions } } : {}), seconds: SECOND },
});

/** 计价字段和表达式取自 2026-11-02 openai.fit 的 /api/pricing、/api/status（按秒、按次、按清晰度分档、按张、按次固定价、按 token、特殊表达式各一个）。 */
const CATALOG: FitCatalog = {
    pricing: [
        task("muse-video", 'tier("720p", u("seconds") * 0.033424657534)', ["720p"]),
        task("seedance2.5 Orion", 'tier("按次", 0.7821917808219179)', ["720p"]),
        task("minimax-h3-chovy", 'u("resolution") == "1440P" ? tier("1440P", 0.1917808219178082) : u("resolution") == "768P" ? tier("768P", 0.13287671232876713) : tier("480P", 0.10273972602739727)', ["480P", "768P", "1440P"]),
        task("wan3.0-video", 'u("resolution") == "720P" ? tier("720P", u("seconds") * 0.0273972602739726) : u("resolution") == "1080P" ? tier("1080P", u("seconds") * 0.045205479452054796) : tier("480P", u("seconds") * 0.021917808219178082)', [
            "480P",
            "720P",
            "1080P",
        ]),
        {
            model_name: "gpt-image-2",
            supported_endpoint_types: ["image-generation"],
            quota_type: 0,
            model_ratio: 37.5,
            completion_ratio: 2,
            enable_groups: ["default"],
            billing_mode: "tiered_expr",
            billing_expr: 'tier("按张", fixed(0.0034246575342465753)) * image_count',
        },
        { model_name: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"], quota_type: 1, model_ratio: 0, completion_ratio: 0, model_price: 0.009589041096, enable_groups: ["default"] },
        {
            model_name: "claude-sonnet-5",
            supported_endpoint_types: ["anthropic", "openai"],
            quota_type: 0,
            model_ratio: 37.5,
            completion_ratio: 1,
            enable_groups: ["Claude"],
            billing_mode: "tiered_expr",
            billing_expr: 'tier("标准", p * 0.2739726027397260273972602740 + c * 1.369863013698630136986301370)',
        },
        {
            model_name: "gpt-image-2-codex",
            supported_endpoint_types: ["image-generation"],
            quota_type: 0,
            model_ratio: 37.5,
            completion_ratio: 2,
            enable_groups: ["default"],
            billing_mode: "tiered_expr",
            billing_expr: 'param("size") == nil ? tier("1k", 16438.35616438356) : tier("2k", 20547.94520547945)',
        },
    ],
    capabilities: null,
    groupRatio: { default: 1, Claude: 0.4 },
    status: { price: 7.3, usd_exchange_rate: 7.3, quota_display_type: "CNY", display_in_currency: true, quota_per_unit: 500000, custom_currency_symbol: "¤", custom_currency_exchange_rate: 1 },
};

const textOf = (element: ReactElement) =>
    renderToStaticMarkup(element)
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&");
const price = (pricing: FitPricing, model: string, selection?: { resolution: string | null; seconds: number | null }) => textOf(<FitPrice pricing={pricing} model={model} selection={selection} />);

test("目录换成 fit 价格库的样子：挂上分组倍率，两个汇率取 status，币种按 status 显示人民币", () => {
    const pricing = applyFitPricing(CATALOG);
    assert.equal(pricing.priceRate, 7.3);
    assert.equal(pricing.usdExchangeRate, 7.3);
    assert.deepEqual(pricing.models.get("claude-sonnet-5")?.group_ratio, { default: 1, Claude: 0.4 });
    assert.equal(price(pricing, "muse-video"), "¥0.244 / 秒");
});

test("没有 status 时和 fit 的默认值一样按美元、汇率 1 显示", () => {
    const pricing = applyFitPricing({ ...CATALOG, status: null });
    assert.deepEqual([pricing.priceRate, pricing.usdExchangeRate], [1, 1]);
    assert.equal(price(pricing, "seedance2.5 Orion"), "$0.782192 / 请求");
    applyFitPricing(CATALOG);
});

test("下拉列表里每个模型的价格和 fit 在线生成台一样：按秒、按次、按清晰度分档、按张、固定按次、特殊表达式", () => {
    const pricing = applyFitPricing(CATALOG);
    assert.equal(price(pricing, "muse-video"), "¥0.244 / 秒");
    assert.equal(price(pricing, "seedance2.5 Orion"), "¥5.71 / 请求");
    assert.equal(price(pricing, "minimax-h3-chovy"), "¥0.75 – ¥1.4 / 请求");
    assert.equal(price(pricing, "wan3.0-video"), "¥0.16 – ¥0.33 / 秒");
    assert.equal(price(pricing, "gpt-image-2"), "¥0.025 / 张");
    assert.equal(price(pricing, "gemini-nano-banana-2.1"), "¥0.07 / 请求");
    assert.equal(price(pricing, "gpt-image-2-codex"), "特殊计费表达式");
});

test("选中的模型按当前清晰度、时长估价：按次分档取那一档，按秒的加上这一条的估价", () => {
    const pricing = applyFitPricing(CATALOG);
    assert.equal(price(pricing, "minimax-h3-chovy", { resolution: "1440P", seconds: 15 }), "¥1.4 / 请求");
    assert.equal(price(pricing, "wan3.0-video", { resolution: "720P", seconds: 5 }), "¥0.16 – ¥0.33 / 秒 · 5s ≈ ¥1");
    assert.equal(price(pricing, "muse-video", { resolution: "720p", seconds: 10 }), "¥0.244 / 秒 · 10s ≈ ¥2.44");
});

test("按 token 计价的文本模型照模型广场写输入、输出两项（按最低分组倍率），不是按 token 的交给 ModelPriceHint", () => {
    const pricing = applyFitPricing(CATALOG);
    assert.equal(price(pricing, "claude-sonnet-5"), "输入 ¥0.8 / 1M · 输出 ¥4 / 1M");
    assert.equal(fitTokenPriceText(pricing.models.get("muse-video")!, pricing), null);
    assert.equal(fitTokenPriceText(pricing.models.get("gemini-nano-banana-2.1")!, pricing), null);
    // 没有计价表达式、按倍率算的老式 token 模型走 fit 的 formatPrice
    const ratio = { ...pricing.models.get("claude-sonnet-5")!, billing_mode: undefined, billing_expr: undefined, model_ratio: 1.25, completion_ratio: 4 };
    assert.equal(fitTokenPriceText(ratio, pricing), "输入 ¥7.3 / 1M · 输出 ¥29.2 / 1M");
});

test("价目表里没有的模型不显示价格", () => {
    assert.equal(price(applyFitPricing(CATALOG), "gpt-6-astra"), "");
});

/** 渲染模型选择器的按钮（下拉列表关着时不渲染），价目表直接塞进 react-query 的缓存。 */
function renderPicker(config: AiConfig, value: string, pricing: FitPricing | null) {
    const client = new QueryClient();
    if (pricing) client.setQueryData(["fit-pricing"], pricing);
    return textOf(
        <QueryClientProvider client={client}>
            <ModelPicker config={config} value={value} capability="video" onChange={() => {}} />
        </QueryClientProvider>,
    );
}

const fitConfig = {
    ...defaultConfig,
    localChannels: [{ id: FIT_CHANNEL_ID, protocol: "openai", name: "openai.fit", baseUrl: FIT_ORIGIN, apiKey: "", models: ["muse-video", "seedance2.5 Orion"], modelCapabilities: { "muse-video": "video", "seedance2.5 Orion": "video" } }],
} as AiConfig;

test("模型选择器的按钮上显示选中 openai.fit 模型的价格，别的渠道不显示", () => {
    const pricing = applyFitPricing(CATALOG);
    assert.equal(renderPicker(fitConfig, "seedance2.5 Orion", pricing), "seedance2.5 Orion¥5.71 / 请求");
    assert.equal(renderPicker(fitConfig, "muse-video", pricing), "muse-video¥0.244 / 秒");
    // 价目表还没到时只显示模型名
    assert.equal(renderPicker(fitConfig, "muse-video", null), "muse-video");
    const remote = { ...defaultConfig, channelMode: "remote", publicChannels: [{ id: "other", protocol: "openai", name: "其他渠道", baseUrl: "https://example.com", models: ["muse-video"], modelCapabilities: { "muse-video": "video" } }] } as AiConfig;
    assert.equal(renderPicker(remote, "muse-video", pricing), "muse-video");
});
