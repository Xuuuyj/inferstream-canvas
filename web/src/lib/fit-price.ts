import { getDynamicDisplayGroupRatio, getDynamicPricingSummary, isUnconfiguredTaskUsageModel } from "@/lib/fit-generate/pricing/lib/dynamic-price";
import { isTokenBasedModel } from "@/lib/fit-generate/pricing/lib/model-helpers";
import { formatPrice } from "@/lib/fit-generate/pricing/lib/price";
import type { PricingModel } from "@/lib/fit-generate/pricing/types";
import { t } from "@/lib/fit-generate/shims/i18n";
import { currencyFromStatus, setCurrencyConfig } from "@/lib/fit-generate/shims/system-config-store";
import type { FitCatalog } from "@/lib/fit-models";

/** 模型名 → fit 价格库要的价目表条目，和两个汇率（fit 生成台传给 ModelPriceHint 的 priceRate、usdExchangeRate）。 */
export type FitPricing = { models: Map<string, PricingModel>; priceRate: number; usdExchangeRate: number };

/**
 * 目录换成 fit 价格库要的样子，照抄 fit 的 use-pricing-data：每个条目挂上价目表顶层的 group_ratio，两个汇率取 /api/status 的 price、usd_exchange_rate（最小 0.001）；
 * 同时把 status 里的币种设置写进 fit 的 currency 配置（fit 拉到 /api/status 后做的同一件事），之后 fit 的格式化按它显示 ¥。
 */
export function applyFitPricing(catalog: FitCatalog): FitPricing {
    const status = catalog.status ?? null;
    setCurrencyConfig(currencyFromStatus(status));
    const priceRate = Math.max((status?.price as number) ?? 1, 0.001);
    const usdExchangeRate = Math.max((status?.usd_exchange_rate as number) ?? priceRate, 0.001);
    const groupRatio = catalog.groupRatio ?? {};
    const models = new Map((Array.isArray(catalog.pricing) ? catalog.pricing : []).map((entry) => [entry.model_name, { ...entry, group_ratio: groupRatio } as unknown as PricingModel]));
    return { models, priceRate, usdExchangeRate };
}

/**
 * 按 token 计价的模型（文本、对话）照模型广场卡片写全输入、输出两项：「输入 ¥0.4 / 1M · 输出 ¥1.2 / 1M」。fit 生成台的 ModelPriceHint 只写第一项（生成台没有文本模型），
 * 所以这类模型用这里的写法；不是按 token 计价的返回 null，交给 ModelPriceHint。价格、标签都出自 fit 的价格库和 zh 文案，没有另算。
 */
export function fitTokenPriceText(model: PricingModel, { priceRate, usdExchangeRate }: Pick<FitPricing, "priceRate" | "usdExchangeRate">) {
    const summary = getDynamicPricingSummary(model, { tokenUnit: "M", priceRate, usdExchangeRate, groupRatioMultiplier: getDynamicDisplayGroupRatio(model) });
    if (summary) {
        const entries = summary.isSpecialExpression ? [] : summary.primaryEntries;
        if (!entries.length || entries.some((entry) => entry.unit !== "token" || !entry.variable)) return null;
        return entries.map((entry) => `${t(entry.shortLabel)} ${entry.formattedRange ?? entry.formatted} / 1M`).join(" · ");
    }
    if (!isTokenBasedModel(model) || isUnconfiguredTaskUsageModel(model)) return null;
    return (["Input", "Output"] as const).map((label) => `${t(label)} ${formatPrice(model, label === "Input" ? "input" : "output", "M", false, priceRate, usdExchangeRate)} / 1M`).join(" · ");
}
