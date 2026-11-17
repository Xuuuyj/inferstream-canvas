import assert from "node:assert/strict";
import test from "node:test";
import type { FitBridgeToken } from "./fit-bridge";
import { createCandidates, groupKindModels, pickToken, planFitKeySlots, rankTokens, replacedSlotText, tokenIssue, tokenModelCount, type KeySelectContext } from "./fit-key-select";
import type { FitCatalog } from "./fit-models";

/** 和线上一样的分组：default/vip 只有图片和视频，文本模型分在 Claude、GPT 这些分组里。 */
const CATALOG: FitCatalog = {
    pricing: [
        { model_name: "seedance-2.0-mini-super", supported_endpoint_types: ["openai-video"], tags: "视频生成", enable_groups: ["default", "vip"] },
        { model_name: "wan3.0-video", supported_endpoint_types: ["openai-video"], tags: "视频生成", enable_groups: ["default"] },
        { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation"], tags: "图像生成", enable_groups: ["default", "vip"] },
        { model_name: "claude-sonnet-5", supported_endpoint_types: ["anthropic", "openai"], enable_groups: ["Claude"] },
        { model_name: "claude-opus-5", supported_endpoint_types: ["anthropic", "openai"], enable_groups: ["Claude"] },
        { model_name: "gpt-6-astra", supported_endpoint_types: ["openai"], enable_groups: ["GPT"] },
        { model_name: "gpt-6-sol", supported_endpoint_types: ["openai"], enable_groups: ["GPT"] },
        { model_name: "tts-1", supported_endpoint_types: ["openai"], enable_groups: ["GPT"] },
        { model_name: "deepseek-v4", supported_endpoint_types: ["openai"], enable_groups: ["DeepSeek"] },
    ],
    capabilities: null,
};
const GROUPS = [
    { name: "default", desc: "默认分组", ratio: 1 },
    { name: "vip", desc: "VIP", ratio: 0.8 },
    { name: "Claude", desc: "Claude 专线", ratio: 1.2 },
    { name: "GPT", desc: "GPT 专线", ratio: 1.5 },
    { name: "DeepSeek", desc: "DeepSeek", ratio: 1.5 },
    { name: "auto", desc: "自动", ratio: null },
];
const NOW = 1_800_000_000;
const token = (id: number, group: string, extra: Partial<FitBridgeToken> = {}): FitBridgeToken => ({ id, name: `令牌${id}`, group, status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true, auto_groups: [], ...extra });
const ctx = (tokens: FitBridgeToken[], extra: Partial<KeySelectContext> = {}): KeySelectContext => ({ tokens, tokensTotal: tokens.length, groups: GROUPS, userGroup: "default", byGroup: groupKindModels(CATALOG), now: NOW, ...extra });
const slot = (item: FitBridgeToken, apiKey = `sk-${item.id}-0123456789abcdef`) => ({ tokenId: item.id, name: item.name, group: item.group, apiKey });

test("groupKindModels files each model under every group in enable_groups, by the same kinds the canvas shows", () => {
    const byGroup = groupKindModels(CATALOG);
    assert.deepEqual([...byGroup.get("default")!.video].sort(), ["seedance-2.0-mini-super", "wan3.0-video"]);
    assert.deepEqual([...byGroup.get("vip")!.image], ["gpt-image-2"]);
    assert.deepEqual([...byGroup.get("GPT")!.text].sort(), ["gpt-6-astra", "gpt-6-sol"]);
    assert.deepEqual([...byGroup.get("GPT")!.audio], ["tts-1"]);
    assert.equal(byGroup.get("default")!.text.size, 0);
});

test("eligibility: disabled, expired, out of quota, unusable group and a group without that kind are all rejected", () => {
    const c = ctx([]);
    assert.equal(tokenIssue(token(1, "", { status: 2 }), "video", c), "disabled");
    assert.equal(tokenIssue(token(1, "", { expired_time: NOW - 1 }), "video", c), "expired");
    assert.equal(tokenIssue(token(1, "", { expired_time: NOW + 60 }), "video", c), null);
    assert.equal(tokenIssue(token(1, "", { unlimited_quota: false, remain_quota: 0 }), "video", c), "quota");
    assert.equal(tokenIssue(token(1, "", { unlimited_quota: false, remain_quota: 500 }), "video", c), null);
    assert.equal(tokenIssue(token(1, "retired"), "video", c), "group");
    assert.equal(tokenIssue(token(1, ""), "text", c), "no_models");
    assert.equal(tokenIssue(token(1, "Claude"), "text", c), null);
    // 空分组跟用户自己的分组走
    assert.equal(tokenModelCount(token(1, ""), "video", c), 2);
    assert.equal(tokenModelCount(token(1, "", {}), "video", ctx([], { userGroup: "vip" })), 1);
    // auto：用 auto_groups 里能用的分组；没写时按用户分组估计
    assert.equal(tokenModelCount(token(1, "auto", { auto_groups: ["Claude", "GPT"] }), "text", c), 4);
    assert.equal(tokenModelCount(token(1, "auto"), "video", c), 2);
    // 目录拿不到时不算模型数，不因此拒绝
    assert.equal(tokenIssue(token(1, ""), "text", ctx([], { byGroup: null })), null);
});

test("video and image prefer the default group, then more models, lower ratio, newer token", () => {
    const tokens = [token(1, "vip"), token(2, ""), token(3, "default"), token(4, "Claude")];
    assert.equal(pickToken("video", ctx(tokens))?.id, 3);
    assert.deepEqual(rankTokens("video", ctx(tokens)).map((item) => item.id), [3, 2, 1]);
    // default 分组都没有时才比模型数和倍率
    assert.equal(pickToken("image", ctx([token(1, "vip"), token(4, "Claude")]))?.id, 1);
});

test("text picks the most text models, then the lower ratio, then the newer token", () => {
    assert.equal(pickToken("text", ctx([token(1, "GPT"), token(2, "Claude"), token(3, "DeepSeek"), token(4, "")]))?.id, 2);
    // 模型数一样（各 2 个）时倍率低的胜出
    assert.equal(pickToken("text", ctx([token(5, "GPT"), token(6, "Claude", { name: "c" })]))?.id, 6);
    assert.equal(pickToken("text", ctx([token(7, "GPT"), token(8, "GPT")]))?.id, 8);
    assert.equal(pickToken("text", ctx([token(9, "")])), null);
});

test("planning keeps a slot the user chose while it still works and replaces one that stopped working", () => {
    const chosen = token(1, "vip");
    const fresh = token(2, "default");
    const text = token(3, "Claude");
    const plan = planFitKeySlots({ video: slot(chosen) }, ctx([chosen, fresh, text]));
    assert.equal("video" in plan.assign, false);
    assert.deepEqual([plan.assign.image?.id, plan.assign.text?.id], [2, 3]);
    const broken = planFitKeySlots({ video: slot(chosen) }, ctx([{ ...chosen, status: 2 }, fresh, text]));
    assert.equal(broken.assign.video?.id, 2);
    assert.deepEqual(broken.replaced, [{ kind: "video", from: "令牌1", to: "令牌2", issue: "disabled" }]);
    assert.equal(replacedSlotText(broken.replaced[0]), "原来的视频令牌「令牌1」已禁用，已改用「令牌2」");
    // 改了名字的令牌顺手更新
    assert.equal(planFitKeySlots({ video: slot(chosen) }, ctx([{ ...chosen, name: "新名字" }, fresh, text])).assign.video?.name, "新名字");
});

test("a slot missing from a complete list is deleted; missing from a truncated list (over 100 tokens) it is kept", () => {
    const fresh = token(2, "default");
    const gone = token(99, "default");
    const complete = planFitKeySlots({ video: slot(gone) }, ctx([fresh]));
    assert.equal(complete.assign.video?.id, 2);
    assert.equal(replacedSlotText(complete.replaced[0]), "原来的视频令牌「令牌99」已删除，已改用「令牌2」");
    const truncated = planFitKeySlots({ video: slot(gone) }, ctx([fresh], { tokensTotal: 150 }));
    assert.equal("video" in truncated.assign, false);
    assert.deepEqual(truncated.replaced, []);
    // 找不到替代时清空槽位并提示另选
    const nothing = planFitKeySlots({ text: slot(token(5, "Claude")) }, ctx([fresh]));
    assert.equal(nothing.assign.text, null);
    assert.equal(replacedSlotText(nothing.replaced[0]), "原来的文本令牌「令牌5」已删除，请在设置里另选一把");
});

test("without the catalog: video and image take the first default-group token, text the first other-group token", () => {
    const tokens = [token(1, "Claude"), token(2, "vip"), token(3, ""), token(4, "GPT")];
    const offline = ctx(tokens, { byGroup: null });
    assert.equal(pickToken("video", offline)?.id, 3);
    assert.equal(pickToken("image", offline)?.id, 3);
    assert.equal(pickToken("text", offline)?.id, 1);
    assert.equal(pickToken("video", ctx([token(1, "Claude")], { byGroup: null })), null);
});

test("one-click create: groups with that kind of model, own group first for video and image (sent as \"\"), most text models first for text", () => {
    const c = ctx([], { userGroup: "vip" });
    assert.deepEqual(createCandidates("video", c).map((item) => [item.group.name, item.count, item.value]), [["vip", 1, ""], ["default", 2, "default"]]);
    assert.deepEqual(createCandidates("text", c).map((item) => [item.group.name, item.count]), [["Claude", 2], ["GPT", 2], ["DeepSeek", 1]]);
    assert.ok(createCandidates("text", c).every((item) => item.group.name !== "auto"));
    assert.deepEqual(createCandidates("video", ctx([], { groups: [{ name: "Claude", desc: "Claude", ratio: 1 }] })), []);
});
