import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildModelProfile } from "@/lib/fit-generate/lib/model-profiles";
import { fitPrecheck } from "@/lib/fit-panel";
import { FIT_CHANNEL_ID } from "@/lib/model-channel";
import type { WorkflowRef } from "@/lib/workflow-channel";
import { canvasToFitValues, withFitMentions } from "@/services/api/fit/values";
import type { VideoResponse } from "@/services/api/video";
import type { AiConfig } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasNodeData, type CanvasNodeMetadata } from "../types";
import { buildNodeGenerationContext, composerMentionsFor, fitNodeAllowsEmptyPrompt, fitNodeReferenceInput, withMediaDuration } from "./canvas-node-generation";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const canvasNode = (id: string, type: CanvasNodeType, metadata: CanvasNodeMetadata = {}): CanvasNodeData => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata });
const wire = (from: string[], to: string) => from.map((id) => ({ id: `${id}-${to}`, fromNodeId: id, toNodeId: to }));

test("组装提示词：只有 openai.fit 出图、出视频时素材写成 @图片N 并按素材改写；工作流、文本和其他渠道照旧写「图片N」", async () => {
    // 内置的「反推提示词」配置节点（文本模式）：输出和 b08d9e8 之前一样
    const reverse = "参考图片：@[node:A]\n任务说明：@[node:T]";
    const reverseNodes = [canvasNode("K", CanvasNodeType.Config, { composerContent: reverse, generationMode: "text" }), canvasNode("A", CanvasNodeType.Image, { content: PNG }), canvasNode("T", CanvasNodeType.Text, { content: "反推一段提示词" })];
    const plain = buildNodeGenerationContext("K", reverseNodes, wire(["A", "T"], "K"), reverse, false);
    assert.equal(plain.prompt, "参考图片：图片1\n任务说明：【文本1】\n\n【文本1】\n反推一段提示词");
    assert.deepEqual(plain.mentionLabels, { A: "图片1" });

    // openai.fit 出视频：写成 @图片1，再由 canvasToFitValues 按 mentionLabels 换成 fit 给这张图的写法
    const composer = "@[node:A] 的女孩走进校门，镜头缓缓推近";
    const videoNodes = [canvasNode("K", CanvasNodeType.Config, { composerContent: composer, generationMode: "video" }), canvasNode("A", CanvasNodeType.Image, { content: PNG })];
    const fit = buildNodeGenerationContext("K", videoNodes, wire(["A"], "K"), composer, true);
    assert.equal(fit.prompt, "@图片1 的女孩走进校门，镜头缓缓推近");
    const card = buildModelProfile({ model_name: "seedance2.0 SEA", supported_endpoint_types: ["openai-video"] });
    assert.ok(card);
    const values = await canvasToFitValues(card, withFitMentions({ videoSeconds: "5" }, fit.mentionLabels), fit.prompt, { references: fit.referenceImages });
    assert.equal(values.prompt, "@图1 的女孩走进校门，镜头缓缓推近");
    assert.equal(buildNodeGenerationContext("K", videoNodes, wire(["A"], "K"), composer, false).prompt, "图片1 的女孩走进校门，镜头缓缓推近");
});

test("composerMentionsFor：openai.fit 的图片、视频才写 @；文本、语音、工作流节点和其他渠道都不写", () => {
    const fit = { activeChannelId: FIT_CHANNEL_ID };
    const other = { activeChannelId: "local-openai", baseUrl: "https://api.example.com/v1", localChannels: [] };
    assert.equal(composerMentionsFor(fit, "image"), true);
    assert.equal(composerMentionsFor(fit, "video"), true);
    assert.equal(composerMentionsFor(fit, "text"), false);
    assert.equal(composerMentionsFor(fit, "audio"), false);
    assert.equal(composerMentionsFor(fit, "video", { id: "workflow-1" }), false);
    assert.equal(composerMentionsFor(other, "image"), false);
    assert.equal(composerMentionsFor(other, "video"), false);
});

/** 假的 document：<video>/<audio> 设 src 后按地址给片长（秒），没登记的地址触发 onerror；记下建过哪些元素。 */
async function withMediaElements(durations: Record<string, number>, run: (created: string[]) => Promise<void>) {
    const globals = globalThis as { document?: unknown };
    const saved = { document: globals.document, had: "document" in globals };
    const created: string[] = [];
    globals.document = {
        createElement: (kind: string) => {
            created.push(kind);
            const media: Record<string, unknown> = { removeAttribute() {}, videoWidth: 1280, videoHeight: 720 };
            Object.defineProperty(media, "src", {
                set: (url: string) =>
                    queueMicrotask(() => (url in durations ? (Object.assign(media, { duration: durations[url] }).onloadedmetadata as () => void)() : (media.onerror as () => void)())),
            });
            return media;
        },
    };
    try {
        await run(created);
    } finally {
        if (saved.had) globals.document = saved.document;
        else delete globals.document;
    }
}

test("画布页接线（bun 导入页面太慢，按源码查）：每处组装上下文都按 composerMentionsFor 传，出片和上传都写片长，fit 轮询出错走 fitPollFailure", () => {
    const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    const count = (pattern: RegExp) => page.match(pattern)?.length ?? 0;
    assert.ok(count(/buildNodeGenerationContext\(/g) >= 2);
    // 提示词面板那一处只拿连进来的素材判断能不能不写提示词（提示词传空），不组装提示词，不算
    const referenceOnly = count(/fitContext=\{[^}]*buildNodeGenerationContext\(panelNode\.id, nodes, connections, "", false\)/g);
    assert.equal(referenceOnly, 1);
    assert.equal(count(/buildNodeGenerationContext\([^;]*composerMentionsFor\((generationConfig, mode, workflowRef|generationConfig, retryMode, retryWorkflowRef)\)\)/g), count(/buildNodeGenerationContext\(/g) - referenceOnly);
    // 轮询的视频、音频两处 + 提交和重试的视频、音频四处
    assert.equal(count(/withMediaDuration\(/g), 6);
    assert.equal(count(/mediaDurationMs: task\.mediaDurationMs,/g), 2);
    assert.match(page, /mediaDurationMs: video\.durationMs \}/);
    assert.match(page, /mediaDurationMs: audio\.durationMs \}/);
    assert.match(page, /fitTask && !controller\.signal\.aborted \? fitPollFailure\(fitPollFailuresRef\.current, failureKey, taskId, error\) : ""/);
    assert.match(page, /fitPollFailuresRef\.current\.delete\(failureKey\)/);
});

test("withMediaDuration：出片后读一次真实片长记在 mediaDurationMs；没有成片、已有片长或读不出时原样返回", async () => {
    await withMediaElements({ "blob:clip": 5.2, "blob:voice": 3 }, async (created) => {
        assert.deepEqual(await withMediaDuration({ id: "v", status: "completed", video_url: "blob:clip" }, "video"), { id: "v", status: "completed", video_url: "blob:clip", mediaDurationMs: 5200 });
        assert.deepEqual(await withMediaDuration({ id: "a", status: "completed", audio_url: "blob:voice" }, "audio"), { id: "a", status: "completed", audio_url: "blob:voice", mediaDurationMs: 3000 });
        assert.deepEqual(created, ["video", "audio"]);
        const queued: VideoResponse = { id: "q", status: "queued" };
        assert.equal(await withMediaDuration(queued, "video"), queued);
        const known = { id: "k", video_url: "blob:clip", mediaDurationMs: 4000 };
        assert.equal(await withMediaDuration(known, "video"), known);
        const broken = { id: "b", url: "blob:broken" };
        assert.equal(await withMediaDuration(broken, "video"), broken);
        assert.deepEqual(created, ["video", "audio", "video"]);
    });
});

const card = (model_name: string, supported_endpoint_types = ["openai-video"]) => {
    const profile = buildModelProfile({ model_name, supported_endpoint_types });
    assert.ok(profile, model_name);
    return profile;
};
const fitNodeConfig = { activeChannelId: FIT_CHANNEL_ID, videoSeconds: "5", vquality: "720p", size: "16:9" } as AiConfig;
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXA=";

test("fitNodeReferenceInput：素材按提交时的摆法（同 fitGenerationIssue）——卡片没有首尾帧用途时首尾帧并进参考图，图片卡把节点原图排在参考图后面", () => {
    const nodes = [
        canvasNode("V", CanvasNodeType.Video, { firstFrameNodeId: "A", lastFrameNodeId: "C" }),
        canvasNode("A", CanvasNodeType.Image, { content: PNG }),
        canvasNode("B", CanvasNodeType.Image, { content: PNG }),
        canvasNode("C", CanvasNodeType.Image, { content: PNG }),
    ];
    const context = buildNodeGenerationContext("V", nodes, wire(["A", "B", "C"], "V"), "", false);
    const sea = fitNodeReferenceInput(card("seedance2.0 SEA"), context);
    assert.deepEqual([sea.references?.map((image) => image.id), sea.firstFrame, sea.lastFrame], [["B", "A", "C"], null, null]);
    const wan = fitNodeReferenceInput(card("wan3.0-video"), context);
    assert.deepEqual([wan.references?.map((image) => image.id), wan.firstFrame?.id, wan.lastFrame?.id], [["B"], "A", "C"]);
    const own = { id: "self", name: "self.png", type: "image/png", dataUrl: PNG };
    assert.deepEqual(
        fitNodeReferenceInput(card("gpt-image-2", ["image-generation", "image-edits"]), context, [own]).references?.map((image) => image.id),
        ["B", "self"],
    );
});

test("画布图片、视频节点只给素材不写提示词：照 fit 5c1c13d 只放行 seedance 2.5-GT 且要有连进来、有内容的素材；别的卡、没素材、卡片没读到、走工作流、别的渠道仍要提示词", async () => {
    const gt = card("seedance 2.5-GT");
    const withRefs = (...refs: CanvasNodeData[]) =>
        buildNodeGenerationContext(
            "V",
            [canvasNode("V", CanvasNodeType.Video), ...refs],
            wire(
                refs.map((node) => node.id),
                "V",
            ),
            "",
            false,
        );
    const image = withRefs(canvasNode("A", CanvasNodeType.Image, { content: PNG }));
    const video = withRefs(canvasNode("M", CanvasNodeType.Video, { content: MP4, mimeType: "video/mp4", mediaDurationMs: 5_000 }));
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, gt, image), true);
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, gt, video), true);
    // 连着的图片节点还没出图（没有内容）不算可发送的素材
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, gt, withRefs(canvasNode("E", CanvasNodeType.Image))), false);
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, gt, withRefs()), false);
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, card("seedance2.0 SEA"), image), false);
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, card("gpt-image-2", ["image-generation", "image-edits"]), image), false);
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, null, image), false);
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, gt, null), false);
    const workflow: WorkflowRef = { scope: "personal", channelId: "comfy", kind: "workflow", workflowId: "workflow-1" };
    assert.equal(fitNodeAllowsEmptyPrompt(fitNodeConfig, gt, image, workflow), false);
    // 视频工作台选的工作流（全局 videoWorkflowRef）不管画布节点，节点自己没走工作流就照常放行
    assert.equal(fitNodeAllowsEmptyPrompt({ ...fitNodeConfig, videoWorkflowRef: workflow }, gt, image), true);
    assert.equal(fitNodeAllowsEmptyPrompt({ ...fitNodeConfig, activeChannelId: "other", localChannels: [], baseUrl: "https://example.com" } as AiConfig, gt, image), false);
    // 和点「生成」后的 fitPrecheck（同一个 validateSubmission）一致
    assert.equal(await fitPrecheck(gt, fitNodeConfig, "", fitNodeReferenceInput(gt, image)), "");
    const sea = card("seedance2.0 SEA");
    assert.equal(await fitPrecheck(sea, fitNodeConfig, "", fitNodeReferenceInput(sea, image)), "请填写提示词");
});

test("画布接线（bun 导入 tsx 太慢，按源码查）：提示词面板的生成按钮和重试按 fitNodeAllowsEmptyPrompt 放行空提示词，预检和它用同一份素材摆法", () => {
    const panel = readFileSync(new URL("./canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
    assert.match(panel, /const fitProfile = useFitProfile\(fitContext && !node\.metadata\?\.workflowRef \? config\.model : undefined\);/);
    assert.match(panel, /const canSubmit = [^\n]*\|\| fitNodeAllowsEmptyPrompt\(config, fitProfile, fitContext \?\? null, node\.metadata\?\.workflowRef\);/);
    const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    assert.match(page, /fitContext=\{panelNode\.type === CanvasNodeType\.Video \|\| isCanvasImageNodeType\(panelNode\.type\) \? buildNodeGenerationContext\(panelNode\.id, nodes, connections, "", false\) : undefined\}/);
    assert.match(
        page,
        /if \(!prompt && !retryWorkflowRef && !\(node\.type === CanvasNodeType\.Video && isAutoDLConfig\(generationConfig\)\) && !\(await fitRetryAllowsEmptyPrompt\(generationConfig, retryMode, context\)\)\) \{\n\s+message\.warning\("找不到提示词，无法重试"\);/,
    );
    assert.match(page, /return fitNodeAllowsEmptyPrompt\(config, profile, context\);/);
    assert.match(page, /return fitPrecheck\(profile, withFitMentions\(config, context\.mentionLabels\), prompt, fitNodeReferenceInput\(profile, context, sourceImages\)\);/);
});
