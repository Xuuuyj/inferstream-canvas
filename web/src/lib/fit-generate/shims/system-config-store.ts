/**
 * 手写垫片，代替 fit 的 web/src/stores/system-config-store.ts（sync-fit-generate 把 shared/currency.ts 的导入改指到这里）。
 * fit 的价格格式化只读 getState().config.currency；画布不用 zustand 持久化，币种设置每次随 /api/fit/catalog 的 status 写进来。
 * 类型和默认值照抄 fit；currencyFromStatus 照抄 fit web/src/lib/status-query.ts 的 mapStatusDataToConfig 里币种那一段。
 */
export type CurrencyDisplayType = "USD" | "CNY" | "TOKENS" | "CUSTOM";

export interface CurrencyConfig {
    displayInCurrency: boolean;
    quotaDisplayType: CurrencyDisplayType;
    quotaPerUnit: number;
    usdExchangeRate: number;
    customCurrencySymbol: string;
    customCurrencyExchangeRate: number;
}

export const DEFAULT_CURRENCY_CONFIG: CurrencyConfig = {
    displayInCurrency: true,
    quotaDisplayType: "USD",
    quotaPerUnit: 500000,
    usdExchangeRate: 1,
    customCurrencySymbol: "¤",
    customCurrencyExchangeRate: 1,
};

const state = { config: { currency: { ...DEFAULT_CURRENCY_CONFIG } } };

export const useSystemConfigStore = { getState: () => state };

function toNumber(value: unknown, fallback: number): number {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (typeof value === "string") {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return fallback;
}

/** fit /api/status 里的币种字段换成 fit 前端存的 CurrencyConfig。 */
export function currencyFromStatus(data: Record<string, unknown> | null | undefined): CurrencyConfig {
    if (!data) return { ...DEFAULT_CURRENCY_CONFIG };
    return {
        displayInCurrency: (data.display_in_currency as boolean | undefined) ?? DEFAULT_CURRENCY_CONFIG.displayInCurrency,
        quotaDisplayType: (data.quota_display_type as CurrencyDisplayType | undefined) ?? DEFAULT_CURRENCY_CONFIG.quotaDisplayType,
        quotaPerUnit: toNumber(data.quota_per_unit, DEFAULT_CURRENCY_CONFIG.quotaPerUnit),
        usdExchangeRate: toNumber(data.usd_exchange_rate, DEFAULT_CURRENCY_CONFIG.usdExchangeRate),
        customCurrencySymbol: (data.custom_currency_symbol as string | undefined)?.trim() || DEFAULT_CURRENCY_CONFIG.customCurrencySymbol,
        customCurrencyExchangeRate: toNumber(data.custom_currency_exchange_rate, DEFAULT_CURRENCY_CONFIG.customCurrencyExchangeRate),
    };
}

/** 换上 fit 的币种设置（fit 拉到 /api/status 后 setConfig 的那一步）。 */
export function setCurrencyConfig(currency: CurrencyConfig) {
    state.config.currency = { ...currency };
}
