"use client";

import { useQuery } from "@tanstack/react-query";
import { applyFitPricing, type FitPricing } from "@/lib/fit-price";
import { fetchFitCatalog } from "@/services/api/fit/catalog";

/** openai.fit 公开价目表（/api/fit/catalog，和模型列表共用 60 秒缓存）换成 fit 价格库要的样子；enabled 为 false、加载中或失败时为 null，模型选择器就不显示价格。 */
export function useFitPricing(enabled: boolean): FitPricing | null {
    const { data } = useQuery({ queryKey: ["fit-pricing"], queryFn: async () => applyFitPricing(await fetchFitCatalog()), enabled, staleTime: 60_000 });
    return (enabled && data) || null;
}
