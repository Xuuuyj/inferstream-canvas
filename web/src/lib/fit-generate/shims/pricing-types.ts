/**
 * 手写垫片，代替 fit 的 web/src/features/pricing/types.ts（sync-fit-generate 把同步副本里的导入改指到这里）。
 * fit 生成库只读价目表条目的这四个字段，/api/fit/catalog 也只返回这四个；空值写成 null 也能用。
 */
export type BillingUsageFieldSchema = {
    type?: "number" | "boolean";
    unit?: string;
    enum?: string[];
};

export type BillingUsageSchema = Record<string, BillingUsageFieldSchema>;

export type PricingModel = {
    model_name: string;
    supported_endpoint_types?: string[] | null;
    tags?: string;
    billing_usage_schema?: BillingUsageSchema | null;
};
