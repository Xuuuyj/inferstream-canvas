import type { FitBridgeGroup, FitBridgeToken } from "@/lib/fit-bridge";
import { FIT_KIND_LABELS, FIT_KINDS } from "@/lib/fit-config";
import { classifyFitModels, type FitCatalog } from "@/lib/fit-models";
import type { FitKeySlot, FitKind, ModelCapability } from "@/stores/use-config-store";

/**
 * 三把令牌的自动预选和一键新建（纯函数）。分组里有哪些视频、图片、文本模型按 /api/fit/catalog 的公开价目表（enable_groups）算，
 * 模型类型和画布最终显示模型的规则一致（classifyFitModels：图片、视频要能建出 fit 生成台的卡片，视频的 family 不能是 unsupported）。
 * 拿到密钥后再用 /v1/models 核实，这里只是估计。
 */
export type GroupKindModels = Map<string, Record<ModelCapability, Set<string>>>;
export type KeySelectContext = {
    tokens: FitBridgeToken[];
    tokensTotal: number;
    groups: FitBridgeGroup[];
    /** 用户自己的分组（令牌分组为空时用它）。 */
    userGroup: string;
    /** 目录拿不到时为 null，走降级规则。 */
    byGroup: GroupKindModels | null;
    /** 当前时间（秒）。 */
    now: number;
};
export type SlotIssue = "disabled" | "expired" | "quota" | "group" | "no_models" | "deleted";

const emptyKinds = (): Record<ModelCapability, Set<string>> => ({ video: new Set(), image: new Set(), text: new Set(), audio: new Set() });

export function groupKindModels(catalog: FitCatalog): GroupKindModels {
    const pricing = Array.isArray(catalog.pricing) ? catalog.pricing : [];
    const list = classifyFitModels(
        pricing.map((entry) => ({ id: entry.model_name, supported_endpoint_types: entry.supported_endpoint_types })),
        catalog,
    );
    const byGroup: GroupKindModels = new Map();
    for (const entry of pricing) {
        const kind = list.modelCapabilities[entry.model_name];
        if (!kind) continue;
        for (const group of Array.isArray(entry.enable_groups) ? entry.enable_groups : []) {
            if (typeof group !== "string") continue;
            if (!byGroup.has(group)) byGroup.set(group, emptyKinds());
            byGroup.get(group)![kind].add(entry.model_name);
        }
    }
    return byGroup;
}

/** 令牌实际用到的分组：空分组跟用户自己的分组走；auto 用 auto_groups 里用户能用的（没写 auto_groups 时按用户分组估计）。 */
export function tokenGroups(token: Pick<FitBridgeToken, "group" | "auto_groups">, ctx: Pick<KeySelectContext, "userGroup" | "groups">) {
    if (token.group === "") return [ctx.userGroup];
    if (token.group !== "auto") return [token.group];
    if (!token.auto_groups.length) return [ctx.userGroup];
    const usable = new Set(ctx.groups.map((group) => group.name));
    return token.auto_groups.filter((group) => usable.has(group));
}

/** 令牌在某类型下能用的模型数（几个分组的并集）；目录拿不到时为 null。 */
export function tokenModelCount(token: FitBridgeToken, kind: ModelCapability, ctx: KeySelectContext) {
    if (!ctx.byGroup) return null;
    const models = new Set<string>();
    for (const group of tokenGroups(token, ctx)) for (const model of ctx.byGroup.get(group)?.[kind] ?? []) models.add(model);
    return models.size;
}

/** 令牌为什么不能用在这一类上；能用返回 null。 */
export function tokenIssue(token: FitBridgeToken, kind: FitKind, ctx: KeySelectContext): Exclude<SlotIssue, "deleted"> | null {
    if (token.status !== 1) return "disabled";
    if (token.expired_time !== -1 && token.expired_time <= ctx.now) return "expired";
    if (!token.unlimited_quota && token.remain_quota <= 0) return "quota";
    if (token.group !== "" && !ctx.groups.some((group) => group.name === token.group)) return "group";
    const count = tokenModelCount(token, kind, ctx);
    return count === null || count > 0 ? null : "no_models";
}

const isDefaultGroup = (group: string) => group === "" || group === "default";

/** 令牌的分组倍率：空分组取用户分组的倍率；auto 和没有倍率的按最高（排最后）。 */
function tokenRatio(token: FitBridgeToken, ctx: KeySelectContext) {
    if (token.group === "auto") return Infinity;
    const name = token.group === "" ? ctx.userGroup : token.group;
    return ctx.groups.find((group) => group.name === name)?.ratio ?? Infinity;
}

/**
 * 给某一类挑令牌：只在能用的令牌里挑。视频、图片：分组为空或 default 的优先，再比该类型模型数多、分组倍率低、令牌 id 大；
 * 文本：模型数多、倍率低、id 大。目录拿不到时：视频、图片取第一把分组为空或 default 的，文本取第一把分组不是空或 default 的。
 */
export function pickToken(kind: FitKind, ctx: KeySelectContext): FitBridgeToken | null {
    const [first] = rankTokens(kind, ctx);
    if (!first || ctx.byGroup) return first ?? null;
    return (kind === "text" ? !isDefaultGroup(first.group) : isDefaultGroup(first.group)) ? first : null;
}

/** 这一类能用的令牌，按 pickToken 的规则排好（下拉框的选项顺序）。目录拿不到时只把偏好的分组排前面，其余保持原顺序。 */
export function rankTokens(kind: FitKind, ctx: KeySelectContext): FitBridgeToken[] {
    const usable = ctx.tokens.filter((token) => !tokenIssue(token, kind, ctx));
    const preferred = (token: FitBridgeToken) => Number(kind === "text" ? !isDefaultGroup(token.group) : isDefaultGroup(token.group));
    if (!ctx.byGroup) return [...usable].sort((a, b) => preferred(b) - preferred(a));
    const count = (token: FitBridgeToken) => tokenModelCount(token, kind, ctx) ?? 0;
    return [...usable].sort(
        (a, b) =>
            (kind === "text" ? 0 : preferred(b) - preferred(a)) ||
            count(b) - count(a) ||
            tokenRatio(a, ctx) - tokenRatio(b, ctx) ||
            b.id - a.id,
    );
}

export type SlotPlan = {
    /** 要换成（或第一次填上）的令牌；为 null 的类别要清空槽位。 */
    assign: Partial<Record<FitKind, FitBridgeToken | null>>;
    /** 原来的槽位为什么被换掉，给提示用。 */
    replaced: Array<{ kind: FitKind; from: string; to: string | null; issue: SlotIssue }>;
};

/**
 * 检查三个槽位：用户选过、仍然能用的不动（名字、分组变了顺手更新）；空的、失效的按 pickToken 重新挑。
 * 列表已经是全部令牌（tokensTotal ≤ tokens.length）还找不到的算已删除；列表被截断（超过 100 把）时找不到的保留，可能只是没列出来。
 */
export function planFitKeySlots(slots: Partial<Record<FitKind, FitKeySlot>>, ctx: KeySelectContext): SlotPlan {
    const plan: SlotPlan = { assign: {}, replaced: [] };
    const complete = ctx.tokensTotal <= ctx.tokens.length;
    for (const kind of FIT_KINDS) {
        const slot = slots[kind];
        let issue: SlotIssue | null = null;
        if (slot) {
            const token = ctx.tokens.find((item) => item.id === slot.tokenId);
            if (!token) {
                if (!complete) continue;
                issue = "deleted";
            } else {
                issue = tokenIssue(token, kind, ctx);
                if (!issue) {
                    if (token.name !== slot.name || token.group !== slot.group) plan.assign[kind] = token;
                    continue;
                }
            }
        }
        const next = pickToken(kind, ctx);
        if (slot && issue) plan.replaced.push({ kind, from: slot.name, to: next?.name ?? null, issue });
        if (next || slot) plan.assign[kind] = next;
    }
    return plan;
}

const issueText: Record<SlotIssue, string> = { disabled: "已禁用", expired: "已过期", quota: "额度用完", group: "分组已不可用", no_models: "分组里没有可用的模型", deleted: "已删除" };

export function replacedSlotText({ kind, from, to, issue }: SlotPlan["replaced"][number]) {
    const head = `原来的${FIT_KIND_LABELS[kind]}令牌「${from || "未命名"}」${issueText[issue]}`;
    return to === null ? `${head}，请在设置里另选一把` : `${head}，已改用「${to}」`;
}

export type CreateCandidate = { group: FitBridgeGroup; count: number | null; value: string };

/**
 * 某一类一把能用的令牌都没有时「一键新建」可选的分组：去掉 auto、该类型模型数 ≥ 1 的分组（目录拿不到时不按模型数筛）。
 * 视频、图片：用户自己的分组优先，其次 default，再比模型数多、倍率低、名字；文本：模型数多、倍率低、名字。
 * 所选分组就是用户自己的分组时传 ""（和注册时的默认令牌一样，用户换分组后令牌跟着变）。
 */
export function createCandidates(kind: FitKind, ctx: KeySelectContext): CreateCandidate[] {
    const count = (group: FitBridgeGroup) => (ctx.byGroup ? (ctx.byGroup.get(group.name)?.[kind].size ?? 0) : null);
    const rank = (group: FitBridgeGroup) => (group.name === ctx.userGroup ? 0 : group.name === "default" ? 1 : 2);
    return ctx.groups
        .filter((group) => group.name !== "auto" && (count(group) ?? 1) > 0)
        .sort(
            (a, b) =>
                (kind === "text" ? 0 : rank(a) - rank(b)) ||
                (count(b) ?? 0) - (count(a) ?? 0) ||
                (a.ratio ?? Infinity) - (b.ratio ?? Infinity) ||
                a.name.localeCompare(b.name),
        )
        .map((group) => ({ group, count: count(group), value: group.name === ctx.userGroup ? "" : group.name }));
}
