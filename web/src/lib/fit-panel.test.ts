import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import axios, { type AxiosAdapter } from "axios";
import { buildNodeGenerationContext } from "@/app/(user)/canvas/components/canvas-node-generation";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "@/app/(user)/canvas/types";
import { buildModelProfile } from "@/lib/fit-generate/lib/model-profiles";
import { buildRelayRequest } from "@/lib/fit-generate/lib/request-builders";
import type { PricingModel } from "@/lib/fit-generate/shims/pricing-types";
import { fetchFitCatalog, loadFitStudio } from "@/services/api/fit/catalog";
import { canvasToFitValues, withFitMentions, type FitReferenceInput, type FitValuesConfig } from "@/services/api/fit/values";
import { FitRequestError } from "@/services/api/fit/video";
import { fitAdvancedPatch, fitPanel, fitPanelSummary, fitPollFailure, fitPrecheck, fitVideoDurationHint, fitVideoSecondsIssue } from "./fit-panel";
import { supportsVideoAudioGeneration, supportsVideoFrameReferences } from "./video-model-capabilities";

const VIDEO = { supported_endpoint_types: ["openai-video"] };
const OPENAI_IMAGE = { supported_endpoint_types: ["image-generation", "image-edits"], tags: "图像生成" };
const GEMINI_IMAGE = { supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" };
const PROMPT = "漫剧分镜：女孩走进校门，镜头缓缓推近";

function profile(model_name: string, extra: Partial<PricingModel> = VIDEO) {
    const result = buildModelProfile({ model_name, ...extra });
    assert.ok(result, model_name);
    return result;
}

async function panelOf(model: string, config: FitValuesConfig = {}, extra: Partial<PricingModel> = VIDEO, options?: { visualOnly?: boolean; showSize?: boolean }) {
    const card = profile(model, extra);
    const values = await canvasToFitValues(card, config, "");
    return { card, values, panel: fitPanel(card, values, options) };
}

const group = (panel: Awaited<ReturnType<typeof panelOf>>["panel"], title: string) => panel.groups.find((item) => item.title === title);
const image = (id: string) => ({ id, name: `${id}.png`, type: "image/png", dataUrl: "" });

test("范围时长给滑块（卡片的最小最大值），清晰度、画幅按卡片列出；没有的项不出现", async () => {
    const { panel } = await panelOf("seedance2.0 SEA", { videoSeconds: "99", vquality: "720", size: "1280x720" });
    assert.deepEqual(panel.seconds, { mode: "range", min: 4, max: 15, value: 15 });
    assert.deepEqual(group(panel, "清晰度"), {
        title: "清晰度",
        key: "vquality",
        value: "720p",
        options: [
            { value: "480p", label: "480p", write: "480p" },
            { value: "720p", label: "720p", write: "720p" },
        ],
    });
    const ratio = group(panel, "画幅")!;
    assert.equal(ratio.key, "size");
    assert.equal(ratio.value, "16:9");
    assert.deepEqual(
        ratio.options.map((option) => option.label),
        ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9", "自适应"],
    );
    assert.equal(ratio.options.find((option) => option.value === "adaptive")?.write, "adaptive");
    assert.deepEqual(
        panel.groups.map((item) => item.title),
        ["清晰度", "画幅"],
    );
    assert.deepEqual(panel.advanced, []);
    assert.equal(panel.references, "参考素材最多 9 个：图片 9");
});

test("档位时长给可选秒数（吸附到最近一档），固定时长只显示不给改；画布的 -1 自动时长不出现", async () => {
    const steps = (await panelOf("seedance-2.0-mini-Chovy", { videoSeconds: "12" })).panel;
    assert.deepEqual(steps.seconds, { mode: "steps", options: [5, 10, 15], value: 10 });
    assert.deepEqual((await panelOf("seedance-2.0-mini-Chovy", { videoSeconds: "-1" })).panel.seconds, { mode: "steps", options: [5, 10, 15], value: 15 });
    const fixed = (await panelOf("seedance-2.0-mini-super", { videoSeconds: "6" })).panel;
    assert.deepEqual(fixed.seconds, { mode: "fixed", value: 15 });
    assert.deepEqual(
        group(fixed, "画幅")?.options.map((option) => option.value),
        ["9:16", "16:9"],
    );
    assert.equal(fixed.references, "参考素材最多 13 个：图片 9 · 视频 3 · 音频 1；至少 1 张参考图");
    assert.match(fixed.hint, /^按次计费，固定 720p、15 秒/);
});

test("时长和画幅跟着清晰度走（Arcturus 720p 最长 5 秒，wan3.0-video 720P 没有自适应）；首尾帧和必须带图写进素材提示", async () => {
    // fit 8b81d2d：seedance2.5 Arcturus 480p 4–12 秒、720p 4–5 秒
    assert.deepEqual((await panelOf("seedance2.5 Arcturus", { vquality: "720p", videoSeconds: "12" })).panel.seconds, { mode: "range", min: 4, max: 5, value: 5 });
    assert.deepEqual((await panelOf("seedance2.5 Arcturus", { vquality: "480p", videoSeconds: "12" })).panel.seconds, { mode: "range", min: 4, max: 12, value: 12 });
    const wan480 = (await panelOf("wan3.0-video", { vquality: "480", videoSeconds: "2" })).panel;
    assert.deepEqual(wan480.seconds, { mode: "range", min: 2, max: 30, value: 2 });
    assert.ok(group(wan480, "画幅")?.options.some((option) => option.value === "adaptive"));
    const wan720 = (await panelOf("wan3.0-video", { vquality: "720p", videoSeconds: "2" })).panel;
    assert.deepEqual(wan720.seconds, { mode: "range", min: 2, max: 30, value: 2 });
    assert.equal(group(wan720, "清晰度")?.value, "720P");
    assert.deepEqual(group(wan720, "画幅")?.options.map((option) => option.value), ["16:9", "4:3", "1:1", "3:4", "9:16"]);
    assert.equal(wan720.references, "参考素材最多 20 个：图片 10 · 视频 5 · 音频 5 · 首帧 1 · 尾帧 1");
    const h3 = (await panelOf("minimax H3")).panel;
    assert.deepEqual(h3.seconds, { mode: "range", min: 4, max: 15, value: 15 });
    assert.deepEqual(group(h3, "清晰度")?.options.map((option) => option.value), ["480P"]);
    assert.equal(h3.references, "参考素材最多 9 个：图片 9");
    // seedance2.5 Polaris: 15-30 s since 11-03 (fit polaris-15s-20261104)
    assert.deepEqual((await panelOf("seedance2.5 Polaris", { videoSeconds: "8" })).panel.seconds, { mode: "range", min: 15, max: 30, value: 15 });
});

test("高级参数只给客户可选项，没选过显示卡片默认值；改动规则同 fit 生成台", async () => {
    const coke = await panelOf("seedance2.0 coke");
    assert.deepEqual(
        coke.panel.advanced.map(({ param, label, value }) => ({ key: param.key, label, value })),
        [{ key: "face", label: "人脸处理（默认关闭）", value: false }],
    );
    assert.equal((await panelOf("seedance2.0 coke", { fitAdvanced: { face: true, generate_audio: false } })).panel.advanced[0].value, true);
    assert.deepEqual(fitAdvancedPatch(coke.card, { face: true, seed: 3 }, "face", false), { seed: 3 });
    assert.deepEqual(fitAdvancedPatch(coke.card, {}, "face", true), { face: true });
    const h3 = { ...coke.card, advanced: [{ key: "ai_enhance", kind: "boolean" as const, labelKey: "AI 润色", defaultValue: true }] };
    assert.deepEqual(fitAdvancedPatch(h3, {}, "ai_enhance", false), { ai_enhance: false });
    // 声音、水印、种子不是客户可选项：GT 不出现任何高级参数
    assert.deepEqual((await panelOf("seedance 2.5-GT")).panel.advanced, []);
});

test("OpenAI 图片卡：尺寸用 fit 的中文标注，画质在高级参数里（auto/low/medium/high）", async () => {
    const stable = await panelOf("gpt-image-2-stable", { size: "2048x1152", quality: "auto" }, OPENAI_IMAGE);
    const size = group(stable.panel, "尺寸")!;
    assert.equal(size.key, "size");
    assert.equal(size.value, "2048x1152");
    assert.equal(size.options.find((option) => option.value === "2048x1152")?.label, "2K · 16:9（2048×1152）");
    assert.equal(stable.panel.seconds, null);
    const quality = stable.panel.advanced[0];
    assert.equal(quality.label, "画质");
    assert.deepEqual(
        quality.options.map((option) => option.label),
        ["自动", "低", "中", "高"],
    );
    assert.equal(quality.value, "medium");
    assert.equal((await panelOf("gpt-image-2-stable", { quality: "high" }, OPENAI_IMAGE)).panel.advanced[0].value, "high");
    assert.equal((await panelOf("gpt-image-2-stable", { quality: "high", fitAdvanced: { quality: "auto" } }, OPENAI_IMAGE)).panel.advanced[0].value, "auto");
    assert.equal(stable.panel.references, "参考素材最多 10 个：图片 10");
    assert.equal(fitPanelSummary(stable.card, stable.values), "中 · 2K · 16:9");
    const plain = await panelOf("gpt-image-2", { size: "auto" }, OPENAI_IMAGE);
    assert.equal(fitPanelSummary(plain.card, plain.values), "自动尺寸");
    assert.deepEqual((await panelOf("gpt-image-2-stable", {}, OPENAI_IMAGE, { showSize: false })).panel.groups, []);
});

test("Gemini 图片卡：列出卡片的全部清晰度、写卡片原值（含 0.5K），画幅单独选", async () => {
    const gemini = await panelOf("gemini-nano-banana-2.1", { quality: "high", size: "16:9" }, GEMINI_IMAGE);
    assert.deepEqual(group(gemini.panel, "清晰度"), {
        title: "清晰度",
        key: "quality",
        value: "4K",
        options: [
            { value: "1K", label: "1K", write: "1K" },
            { value: "2K", label: "2K", write: "2K" },
            { value: "4K", label: "4K", write: "4K" },
        ],
    });
    assert.equal(group(gemini.panel, "画幅")?.value, "16:9");
    assert.equal(fitPanelSummary(gemini.card, gemini.values), "4K · 16:9");
    // gemini-3.1-flash-image-preview 在 fit 生成台还有 0.5K：选中后面板高亮它，请求发 imageSize 512
    const flash = await panelOf("gemini-3.1-flash-image-preview", { quality: "0.5K" }, GEMINI_IMAGE);
    const tiers = group(flash.panel, "清晰度")!;
    assert.deepEqual(
        tiers.options.map((option) => option.write),
        flash.card.imageSizes,
    );
    assert.ok(tiers.options.some((option) => option.value === "0.5K"));
    assert.equal(tiers.value, "0.5K");
    const request = buildRelayRequest(flash.card, flash.values);
    assert.equal(request.transport === "json" && (request.body.generationConfig as { imageConfig: { imageSize: string } }).imageConfig.imageSize, "512");
    assert.deepEqual(
        (await panelOf("gemini-nano-banana-2.1", {}, GEMINI_IMAGE, { showSize: false })).panel.groups.map((item) => item.title),
        ["清晰度"],
    );
});

test("助手输入框只给清晰度和画幅；按钮摘要和真正发出去的值一致", async () => {
    const visual = (await panelOf("seedance2.0 SEA", {}, VIDEO, { visualOnly: true })).panel;
    assert.deepEqual({ ...visual, groups: visual.groups.map((item) => item.title) }, { seconds: null, groups: ["清晰度", "画幅"], advanced: [], references: "", hint: "" });
    const sea = await panelOf("seedance2.0 SEA", { vquality: "720", size: "1280x720", videoSeconds: "10" });
    assert.equal(fitPanelSummary(sea.card, sea.values), "720p · 16:9 · 10s");
    assert.equal(fitPanelSummary(sea.card, sea.values, false), "720p · 16:9");
    const fixed = await panelOf("seedance-2.0-mini-super", { videoSeconds: "6" });
    assert.equal(fitPanelSummary(fixed.card, fixed.values), "720p · 9:16 · 15s");
});

test("生成前预检：不读素材内容，张数、用途、种类、提示词按 fit 校验；读不出的时长留给视频接口", async () => {
    const check = (model: string, input: FitReferenceInput, prompt = PROMPT, config: FitValuesConfig = {}) => fitPrecheck(profile(model), config, prompt, input);
    assert.equal(await check("seedance2.0 SEA", { references: [image("a"), image("b")] }), "");
    assert.equal(await check("seedance2.0 SEA", { references: Array.from({ length: 10 }, (_, index) => image(`p${index}`)) }), "图片参考最多 9 个；参考素材总数最多 9 个；素材总数最多 9 个");
    assert.equal(await check("seedance2.0 SEA", {}, ""), "请填写提示词");
    assert.equal(await check("seedance2.0 SEA", { references: [image("a")] }, "漫剧分镜：@图片2 的女孩走进校门"), "提示词里引用了 @图片2，但没有对应的参考素材");
    assert.equal(await check("minimax H3", {}), "");
    assert.equal(await check("seedance-2.0-mini-super", {}), "此模型至少需要 1 张参考图");
    assert.equal(await check("seedance2.0 SEA", { firstFrame: image("first") }), "该模型没有 首帧 这个用途");
    const clip = { id: "clip", name: "clip.mp4", type: "video/mp4", url: "blob:clip" };
    // wan3.0-video：480P 不收参考视频，720P 收（fit 8b81d2d）
    assert.equal(await check("wan3.0-video", { videoReferences: [{ ...clip, durationMs: 5000 }] }), "该模型在 480P 下不支持参考视频");
    assert.equal(await check("wan3.0-video", { videoReferences: [{ ...clip, durationMs: 5000 }] }, PROMPT, { vquality: "720P" }), "");
    assert.equal(await check("wan3.0-video-prime", { references: [image("a")], videoReferences: [clip] }), "");
    assert.equal(await check("wan3.0-video-prime", { references: [image("a")], videoReferences: [{ ...clip, durationMs: 40_000 }] }), "clip.mp4 长 40 秒；视频参考必须在 1–15 秒之间");
    // fit 8b81d2d 起 720P 也能带尾帧
    assert.equal(await check("wan3.0-video", { firstFrame: image("first"), lastFrame: image("last") }, PROMPT, { vquality: "720P" }), "");
});

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXA=";
const canvasNode = (id: string, type: CanvasNodeType, metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata });
const picture = (id: string) => canvasNode(id, CanvasNodeType.Image, { content: PNG });
const wire = (from: string[], to: string) => from.map((id) => ({ id: `${id}-${to}`, fromNodeId: id, toNodeId: to }));

/** 照画布在 openai.fit 下点「生成」视频时的做法：从节点上取素材和 @ 标签（组装提示词写 @），卡片没有首尾帧用途时首尾帧并进参考图，再预检。 */
async function canvasPrecheck(model: string, nodes: CanvasNodeData[], connections: ReturnType<typeof wire>, nodeId: string, prompt: string, config: FitValuesConfig = { videoSeconds: "5", vquality: "480p" }) {
    const card = profile(model);
    const context = buildNodeGenerationContext(nodeId, nodes, connections, prompt, true);
    const frames = card.roles.some((role) => role !== "reference");
    const extra = frames ? [] : [context.firstFrame, context.lastFrame].filter((item) => item != null);
    const input: FitReferenceInput = {
        references: [...context.referenceImages, ...extra],
        firstFrame: frames ? context.firstFrame : null,
        lastFrame: frames ? context.lastFrame : null,
        videoReferences: context.referenceVideos,
        audioReferences: context.referenceAudios,
    };
    const settings = withFitMentions(config, context.mentionLabels);
    const issue = await fitPrecheck(card, settings, context.prompt, input);
    return { issue, values: issue ? null : await canvasToFitValues(card, settings, context.prompt, input), context };
}

test("画布节点生成：@图片N 按连线顺序的标签找到素材，首帧、首尾帧、首尾帧并进参考图、组装提示词都指向同一张图", async () => {
    // 首帧 + 参考图：A 选成首帧，B、C 普通参考图
    const love = await canvasPrecheck("seedance2.0 mini Love", [canvasNode("V", CanvasNodeType.Video, { firstFrameNodeId: "A" }), picture("A"), picture("B"), picture("C")], wire(["A", "B", "C"], "V"), "V", "@图片2 牵着 @图片3 的手，从 @图片1 的画面开始");
    assert.equal(love.issue, "");
    assert.equal(love.values?.prompt, "@图1 牵着 @图2 的手，从 @首帧 的画面开始");
    // 首尾帧（wan3.0-video 480P 收首尾帧）
    const wan = await canvasPrecheck("wan3.0-video", [canvasNode("V", CanvasNodeType.Video, { firstFrameNodeId: "A", lastFrameNodeId: "B" }), picture("A"), picture("B")], wire(["A", "B"], "V"), "V", "@图片1 的女孩慢慢走到 @图片2 的位置，镜头跟随");
    assert.equal(wan.issue, "");
    assert.equal(wan.values?.prompt, "@首帧 的女孩慢慢走到 @尾帧 的位置，镜头跟随");
    // 卡片没有首尾帧用途：首帧 A、尾帧 C 追加在参考图 B 后面
    const sea = await canvasPrecheck(
        "seedance2.0 SEA",
        [canvasNode("V", CanvasNodeType.Video, { firstFrameNodeId: "A", lastFrameNodeId: "C" }), picture("A"), picture("B"), picture("C")],
        wire(["A", "B", "C"], "V"),
        "V",
        "@图片1 回头看着 @图片2，走向 @图片3",
    );
    assert.equal(sea.issue, "");
    assert.equal(sea.values?.prompt, "@图2 回头看着 @图1，走向 @图3");
    assert.deepEqual(
        sea.values?.references.map((reference) => reference.id.replace(/^\d+-/, "")),
        ["B", "A", "C"],
    );
    // 组装提示词：按提到的顺序编号，A 同时是首帧
    const composer = "@[node:B] 牵着 @[node:A] 的手";
    const configNode = canvasNode("K", CanvasNodeType.Config, { composerContent: composer, generationMode: "video", firstFrameNodeId: "A" });
    const composed = await canvasPrecheck("seedance2.0 mini Love", [configNode, picture("A"), picture("B")], wire(["A", "B"], "K"), "K", composer);
    assert.deepEqual(composed.context.mentionLabels, { B: "图片1", A: "图片2" });
    assert.equal(composed.issue, "");
    assert.equal(composed.values?.prompt, "@图1 牵着 @首帧 的手");
    // 提示词引用了没连上的素材：直接拦下
    const missing = await canvasPrecheck("seedance2.0 SEA", [canvasNode("V", CanvasNodeType.Video), picture("A")], wire(["A"], "V"), "V", "@图片2 的女孩走进校门");
    assert.equal(missing.issue, "提示词里引用了 @图片2，但没有对应的参考素材");
});

test("生成出来的视频节点 durationMs 是生成耗时：连进限制片长的卡不拿它当片长（生成 180 秒、片长 5 秒能过预检）；上传的视频照常检查", async () => {
    const generated = canvasNode("G", CanvasNodeType.Video, { content: MP4, status: "success", mimeType: "video/mp4", startedAt: Date.now() - 180_000, durationMs: 180_000 });
    const result = await canvasPrecheck("seedance 2.5-GT", [canvasNode("V", CanvasNodeType.Video), generated], wire(["G"], "V"), "V", "让 @视频1 里的女孩转身微笑，镜头缓慢推进", { videoSeconds: "15" });
    assert.equal(result.context.referenceVideos[0].durationMs, undefined);
    assert.equal(result.issue, "");
    // 出片时记下了真实片长（mediaDurationMs）：预检照常按片长查，5 秒能过、40 秒拦下
    const short = canvasNode("G", CanvasNodeType.Video, { ...generated.metadata, mediaDurationMs: 5000 });
    const shortCheck = await canvasPrecheck("seedance 2.5-GT", [canvasNode("V", CanvasNodeType.Video), short], wire(["G"], "V"), "V", "让 @视频1 里的女孩转身微笑，镜头缓慢推进", { videoSeconds: "15" });
    assert.equal(shortCheck.context.referenceVideos[0].durationMs, 5000);
    assert.equal(shortCheck.issue, "");
    assert.equal(shortCheck.values?.references[0].durationSeconds, 5);
    const long = canvasNode("G", CanvasNodeType.Video, { ...generated.metadata, mediaDurationMs: 40_000 });
    const longCheck = await canvasPrecheck("seedance 2.5-GT", [canvasNode("V", CanvasNodeType.Video), long], wire(["G"], "V"), "V", "让 @视频1 里的女孩转身微笑，镜头缓慢推进", { videoSeconds: "15" });
    assert.match(longCheck.issue, /video-G\.mp4 长 40 秒/);
    const uploaded = canvasNode("U", CanvasNodeType.Video, { content: MP4, status: "success", mimeType: "video/mp4", durationMs: 40_000 });
    const upload = await canvasPrecheck("seedance 2.5-GT", [canvasNode("V", CanvasNodeType.Video), uploaded], wire(["U"], "V"), "V", "让 @视频1 里的女孩转身微笑，镜头缓慢推进", { videoSeconds: "15" });
    assert.match(upload.issue, /video-U\.mp4 长 40 秒/);
});

test("节点自己的高级参数覆盖全局值：面板显示的、改动的基准和发出去的请求一致（两个节点弹层都带上 node.metadata.fitAdvanced）", async () => {
    const card = profile("gpt-image-2-stable", OPENAI_IMAGE);
    const global: FitValuesConfig = { quality: "auto", fitAdvanced: { quality: "low" } };
    const node = canvasNode("N", CanvasNodeType.Image, { fitAdvanced: { quality: "high" } });
    // 和两个 buildNodeConfig、画布的 buildGenerationConfig 同一条规则
    const config = { ...global, fitAdvanced: node.metadata?.fitAdvanced || global.fitAdvanced };
    const values = await canvasToFitValues(card, config, "画一只猫");
    assert.equal(fitPanel(card, values).advanced[0].value, "high");
    const request = buildRelayRequest(card, values);
    assert.equal(request.transport === "json" && request.body.quality, "high");
    assert.deepEqual(fitAdvancedPatch(card, config.fitAdvanced, "quality", "medium"), { quality: "medium" });
    for (const file of ["canvas-node-prompt-panel.tsx", "canvas-config-node-panel.tsx"]) {
        const source = readFileSync(new URL(`../app/(user)/canvas/components/${file}`, import.meta.url), "utf8");
        assert.match(source, /fitAdvanced: node\.metadata\?\.fitAdvanced \|\| globalConfig\.fitAdvanced,/, file);
    }
});

test("画布轮询 openai.fit 视频出错：临时错误接着等不计数；其他错误连续 5 次判失败，查成功一次清零；还没拿到 fit 任务号时不算", () => {
    const failures = new Map<string, number>();
    const key = "V:video_1";
    const poll = (error: unknown, taskId = "video_1") => fitPollFailure(failures, key, taskId, error);
    // 断网、502、429、408：等多久都不判失败
    for (const status of [undefined, 502, 503, 429, 408, undefined, 500]) assert.equal(poll(new FitRequestError("连接 openai.fit 失败，请检查网络后重试", status)), "");
    assert.equal(failures.size, 0);
    // 令牌失效（401）：前 4 次照旧等，第 5 次返回原因、清掉计数
    const denied = new FitRequestError("无效的令牌", 401);
    for (let index = 0; index < 4; index += 1) assert.equal(poll(denied), "");
    assert.equal(failures.get(key), 4);
    assert.equal(poll(denied), "无效的令牌");
    assert.equal(failures.has(key), false);
    // 中间查成功一次（调用方 delete）就重新数；临时错误夹在中间不打断也不计数
    for (let index = 0; index < 4; index += 1) poll(new FitRequestError("任务不存在", 404));
    failures.delete(key);
    for (let index = 0; index < 5; index += 1) assert.equal(poll(index === 2 ? new FitRequestError("bad gateway", 502) : new Error("返回内容无法解析")), "");
    assert.equal(failures.get(key), 4);
    assert.equal(poll(new Error("返回内容无法解析")), "返回内容无法解析");
    // 提交还没返回（节点上只有 client_ 任务号，fit/video.ts 直接抛错）：一直等
    for (let index = 0; index < 10; index += 1) assert.equal(poll(new Error("视频任务还在提交，openai.fit 还没有返回任务号"), "client_video_task_x"), "");
    assert.equal(failures.size, 0);
});

test("助手发视频的时长按卡片规则（跟着清晰度走），不再按模型名字猜；-1 用卡片默认时长", () => {
    const sea = profile("seedance2.0 SEA");
    assert.deepEqual(fitVideoDurationHint(sea, "480p"), { min: 4, max: 15, range: "4-15 秒内任意整数秒" });
    assert.equal(fitVideoSecondsIssue(sea, "480p", 8), "");
    assert.equal(fitVideoSecondsIssue(sea, "480p", -1), "");
    assert.equal(fitVideoSecondsIssue(sea, "480p", 20), "当前视频模型仅支持 4-15 秒");
    assert.equal(fitVideoSecondsIssue(sea, "480p", 7.5), "视频总时长必须为整数秒");
    const chovy = profile("seedance-2.0-mini-Chovy");
    assert.deepEqual(fitVideoDurationHint(chovy, ""), { values: [5, 10, 15], range: "仅 5、10、15 秒" });
    assert.equal(fitVideoSecondsIssue(chovy, "", 12), "当前视频模型仅支持 5、10、15 秒");
    // 固定时长的卡不管传多少，fit 都按卡片发
    const fixed = profile("seedance-2.0-mini-super");
    assert.deepEqual(fitVideoDurationHint(fixed, ""), { values: [15], range: "固定 15 秒" });
    assert.equal(fitVideoSecondsIssue(fixed, "", 6), "");
    // seedance2.5 Arcturus：480p 4–12 秒，720p 4–5 秒
    const arcturus = profile("seedance2.5 Arcturus");
    assert.equal(fitVideoSecondsIssue(arcturus, "480p", 12), "");
    assert.equal(fitVideoSecondsIssue(arcturus, "720p", 12), "当前视频模型仅支持 4-5 秒");
});

test("fit 模型的首尾帧和声音按卡片判断，不再按名字猜（profile 由 loadFitStudio 加载）", async () => {
    const models = ["wan3.0-video", "seedance2.0 SEA", "seedance 2.5-GT"].map((id) => ({ id, supported_endpoint_types: ["openai-video"] }));
    const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter, now: Date.now };
    // 时钟拨到 1 小时后，别的测试文件留下的 60 秒缓存都过期
    let now = Date.now() + 3_600_000;
    Date.now = () => now;
    globalThis.fetch = (async () => Response.json({ success: true, data: models })) as unknown as typeof fetch;
    const adapter: AxiosAdapter = async (config) => ({
        data: { code: 0, data: { pricing: models.map((model) => ({ model_name: model.id, supported_endpoint_types: model.supported_endpoint_types })), capabilities: null }, msg: "" },
        status: 200,
        statusText: "",
        headers: {},
        config,
    });
    axios.defaults.adapter = adapter;
    try {
        // 名字规则以前是：wan3.0-video 不收首尾帧，SEA 收，GT 能开声音
        await loadFitStudio({ video: "sk-fit-panel-capabilities", image: "sk-fit-panel-capabilities", text: "sk-fit-panel-capabilities" });
        assert.equal(supportsVideoFrameReferences("wan3.0-video", "openai"), true);
        assert.equal(supportsVideoFrameReferences("seedance2.0 SEA", "openai"), false);
        assert.equal(supportsVideoAudioGeneration("seedance 2.5-GT"), false);
        assert.equal(supportsVideoAudioGeneration("seedance2.0 SEA"), false);
    } finally {
        // 清掉这里留下的「未来时间」缓存（失败的请求不缓存），免得后面的测试文件拿到它
        now += 120_000;
        globalThis.fetch = (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
        axios.defaults.adapter = async () => Promise.reject(new Error("offline"));
        await loadFitStudio({ video: "sk-fit-panel-cleanup", image: "", text: "" }).catch(() => undefined);
        await fetchFitCatalog().catch(() => undefined);
        globalThis.fetch = original.fetch;
        axios.defaults.adapter = original.adapter;
        Date.now = original.now;
    }
});
