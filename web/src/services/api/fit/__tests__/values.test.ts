import assert from "node:assert/strict";
import test from "node:test";
import { buildModelProfile } from "@/lib/fit-generate/lib/model-profiles";
import { usedMentions } from "@/lib/fit-generate/lib/prompt-mentions";
import { buildRelayRequest } from "@/lib/fit-generate/lib/request-builders";
import { validateSubmission } from "@/lib/fit-generate/lib/validate-submission";
import type { PricingModel } from "@/lib/fit-generate/shims/pricing-types";
import type { GenerationFormValues } from "@/lib/fit-generate/types";
import { canvasToFitValues, fitIssueText, fitPriceSelection, type FitValuesConfig } from "../values";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXA=";
const MP3 = "data:audio/mpeg;base64,SUQzBAA=";

function profile(model_name: string, extra: Partial<PricingModel> = {}) {
    const result = buildModelProfile({ model_name, supported_endpoint_types: ["openai-video"], ...extra });
    assert.ok(result, model_name);
    return result;
}

const image = (id: string) => ({ id, name: `${id}.png`, type: "image/png", dataUrl: PNG });
const values = (model: string, config: FitValuesConfig, prompt = "漫剧分镜：女孩走进校门", extra: Partial<PricingModel> = {}) => canvasToFitValues(profile(model, extra), config, prompt);

test("时长：有范围的夹到范围里，有档位的吸附到最近一档，-1 和空值用卡片默认值，固定时长不填", async () => {
    // seedance2.0 SEA：4–15 秒，默认 5
    assert.equal((await values("seedance2.0 SEA", { videoSeconds: "99" })).seconds, 15);
    assert.equal((await values("seedance2.0 SEA", { videoSeconds: "1" })).seconds, 4);
    assert.equal((await values("seedance2.0 SEA", { videoSeconds: "7.6" })).seconds, 8);
    // seedance-2.0-mini-Chovy：只有 5 / 10 / 15 秒
    assert.equal((await values("seedance-2.0-mini-Chovy", { videoSeconds: "12" })).seconds, 10);
    assert.equal((await values("seedance-2.0-mini-Chovy", { videoSeconds: "13" })).seconds, 15);
    assert.equal((await values("seedance-2.0-mini-Chovy", { videoSeconds: "4" })).seconds, 5);
    assert.equal((await values("seedance2.0 SEA", { videoSeconds: "-1" })).seconds, 5);
    assert.equal((await values("seedance-2.0-mini-Chovy", { videoSeconds: "-1" })).seconds, 15);
    assert.equal((await values("seedance2.0 SEA", {})).seconds, 5);
    // seedance-2.0-mini-super 固定 15 秒：表单不填，请求照卡片发 15
    const fixed = await values("seedance-2.0-mini-super", { videoSeconds: "8" });
    assert.equal(fixed.seconds, null);
    const request = buildRelayRequest(profile("seedance-2.0-mini-super"), fixed);
    assert.equal(request.transport === "json" && request.body.seconds, 15);
    // seedance2.5 Arcturus 720p 最长 5 秒、480p 最长 12 秒，范围按选中的清晰度算
    assert.equal((await values("seedance2.5 Arcturus", { vquality: "720p", videoSeconds: "12" })).seconds, 5);
    assert.equal((await values("seedance2.5 Arcturus", { vquality: "480p", videoSeconds: "12" })).seconds, 12);
    // wan3.0-video 720P 没有自适应画幅：画布选了自适应就取这个清晰度下可选的
    assert.equal((await values("wan3.0-video", { vquality: "480", size: "adaptive" })).aspectRatio, "adaptive");
    assert.notEqual((await values("wan3.0-video", { vquality: "720", size: "adaptive" })).aspectRatio, "adaptive");
});

test("价格提示用的清晰度和时长：和表单换算一样，固定时长的卡给固定秒数（fit 生成台传给 ModelPriceHint 的值）", () => {
    assert.deepEqual(fitPriceSelection(profile("seedance2.5 Arcturus"), { vquality: "720p", videoSeconds: "12" }), { resolution: "720p", seconds: 5 });
    assert.deepEqual(fitPriceSelection(profile("seedance-2.0-mini-Chovy"), { videoSeconds: "12" }), { resolution: fitPriceSelection(profile("seedance-2.0-mini-Chovy"), {}).resolution, seconds: 10 });
    assert.equal(fitPriceSelection(profile("seedance-2.0-mini-super"), { videoSeconds: "8" }).seconds, 15);
});

test("清晰度不分大小写、不管有没有 p，返回卡片的写法；对不上用卡片默认值", async () => {
    assert.equal((await values("wan3.0-video", { vquality: "720" })).resolution, "720P");
    assert.equal((await values("wan3.0-video", { vquality: "720p" })).resolution, "720P");
    assert.equal((await values("seedance2.0 SEA", { vquality: "720P" })).resolution, "720p");
    assert.equal((await values("minimax H3 2K", { vquality: "2k" })).resolution, "2K");
    assert.equal((await values("wan3.0-video", { vquality: "1080" })).resolution, "480P");
    assert.equal((await values("seedance2.0 SEA", { vquality: "high" })).resolution, "480p");
});

test("画幅：1280x720 换算成 16:9，auto 对应 adaptive，对不上用卡片默认值", async () => {
    assert.equal((await values("seedance2.0 SEA", { size: "1280x720" })).aspectRatio, "16:9");
    assert.equal((await values("seedance2.0 SEA", { size: "720x1280" })).aspectRatio, "9:16");
    assert.equal((await values("seedance2.0 SEA", { size: "21:9" })).aspectRatio, "21:9");
    assert.equal((await values("seedance2.0 SEA", { size: "auto" })).aspectRatio, "adaptive");
    assert.equal((await values("seedance2.0 SEA", { size: "1792x1024" })).aspectRatio, "16:9");
    assert.equal((await values("seedance-2.0-mini-super", { size: "1:1" })).aspectRatio, "9:16");
});

test("图片尺寸：OpenAI 卡先找相同尺寸、再找同画幅的；Gemini 卡用画幅加质量档", async () => {
    const openai = { supported_endpoint_types: ["image-generation", "image-edits"], tags: "图像生成" };
    const size = async (model: string, config: FitValuesConfig) => (await values(model, config, "画一只猫", openai)).imageSize;
    assert.equal(await size("gpt-image-2", { size: "1024x1792" }), "1024x1792");
    assert.equal(await size("gpt-image-2", { size: "16:9" }), "2048x1152");
    assert.equal(await size("gpt-image-2", { size: "3:4" }), "1024x1360");
    assert.equal(await size("gpt-image-2", { size: "1920x1080" }), "2048x1152");
    assert.equal(await size("gpt-image-2", { size: "3840x2160" }), "3840x2160");
    assert.equal(await size("gpt-image-2", { size: "auto" }), "auto");
    assert.equal(await size("gpt-image-2-1K-4K", { size: "auto" }), "1024x1024");
    const geminiCard = { supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" };
    const gemini = await values("gemini-nano-banana-2.1", { size: "2048x1152", quality: "4K" }, "画一只猫", geminiCard);
    assert.equal(gemini.aspectRatio, "16:9");
    assert.equal(gemini.imageSize, "4K");
    // Gemini 直接用卡片原值（面板写进 quality），0.5K 也能选，请求里发 512；低/中/高仍按 1K/2K/4K 换算
    const flash = profile("gemini-3.1-flash-image-preview", geminiCard);
    const half = await canvasToFitValues(flash, { quality: "0.5K" }, "画一只猫");
    assert.equal(half.imageSize, "0.5K");
    const request = buildRelayRequest(flash, half);
    assert.equal(request.transport === "json" && (request.body.generationConfig as { imageConfig: { imageSize: string } }).imageConfig.imageSize, "512");
    assert.equal((await values("gemini-nano-banana-2.1", { quality: "high" }, "画一只猫", geminiCard)).imageSize, "4K");
    assert.equal((await values("gemini-nano-banana-2.1", { quality: "0.5K" }, "画一只猫", geminiCard)).imageSize, "1K");
});

test("高级参数只写卡片有的客户可选项；画布的声音、水印开关不改 fit 卡片的默认请求", async () => {
    const coke = await values("seedance2.0 coke", { fitAdvanced: { face: true, seed: 7, generate_audio: true } });
    assert.deepEqual(coke.advanced, { face: true });
    assert.deepEqual((await values("seedance2.0 SEA", { fitAdvanced: { face: true } })).advanced, {});
    const gt = profile("seedance 2.5-GT");
    const gtValues = await canvasToFitValues(gt, { fitAdvanced: { generate_audio: false, watermark: true } }, "漫剧分镜：女孩回头微笑");
    assert.deepEqual(gtValues.advanced, {});
    const body = buildRelayRequest(gt, gtValues);
    assert.equal(body.transport === "json" && body.body.generate_audio, true);
    assert.equal(body.transport === "json" && body.body.watermark, false);
    const openai = { supported_endpoint_types: ["image-generation", "image-edits"], tags: "图像生成" };
    assert.deepEqual((await values("gpt-image-2-stable", { quality: "high" }, "画一只猫", openai)).advanced, { quality: "high" });
    assert.deepEqual((await values("gpt-image-2-stable", { quality: "auto" }, "画一只猫", openai)).advanced, {});
    assert.deepEqual((await values("gpt-image-2-stable", { quality: "high", fitAdvanced: { quality: "auto" } }, "画一只猫", openai)).advanced, { quality: "auto" });
    assert.deepEqual((await values("gpt-image-2-codex", { quality: "high" }, "画一只猫", openai)).advanced, {});
    assert.deepEqual((await values("seedance2.5 Ultra", { fitAdvanced: { face_split: "yes" } })).advanced, {});
});

/** 提示词里每个 fit 写法实际指向的画布素材（素材 id 是「序号-画布节点 id」）。 */
const pointsAt = (result: GenerationFormValues) => usedMentions(result.prompt, result.references).map((option) => `${option.token}=${option.asset.id.replace(/^\d+-/, "")}`);
const clip = (id: string, kind: "video" | "audio", durationMs = 5000) => ({ id, name: `${id}.${kind === "video" ? "mp4" : "mp3"}`, type: kind === "video" ? "video/mp4" : "audio/mpeg", url: kind === "video" ? MP4 : MP3, durationMs });

test("提示词：没给画布标签时参考图、视频、音频各自按顺序编号（工作台的编法），系统提示词按类型拼在前面；没有的素材直接报错", async () => {
    const config = { systemPrompt: "通用", systemPrompts: { image: "", video: "视频风格：国漫", text: "", workflow: "", workflowAgent: "" } };
    const result = await canvasToFitValues(profile("seedance 2.0 fast-GT"), config, "@图片1 牵着 @图片2 的手，参考 @视频1", { references: [image("a"), image("b")], videoReferences: [clip("v", "video")] });
    assert.equal(result.prompt, "视频风格：国漫\n\n@图1 牵着 @图2 的手，参考 @视频1");
    // 工作台的首帧不占 @图片N 的编号
    const framed = await canvasToFitValues(profile("seedance2.0 mini Love"), {}, "@图片1 的女孩挥手", { firstFrame: image("first"), references: [image("ref")] });
    assert.deepEqual(pointsAt(framed), ["@图1=ref"]);
    const openai = { supported_endpoint_types: ["image-generation"], tags: "图像生成" };
    await assert.rejects(values("gpt-image-2", { systemPrompt: "通用" }, "@图片12 换成红色", openai), /提示词里引用了 @图片12，但没有对应的参考素材/);
});

test("@ 引用按素材改写：画布按连线顺序给全部图片编号（首尾帧也算），换成 fit 给同一个素材的写法", async () => {
    const labels = { A: "图片1", B: "图片2", C: "图片3" };
    const settings = (extra: FitValuesConfig = {}): FitValuesConfig => ({ videoSeconds: "5", vquality: "480p", fitMentionLabels: labels, ...extra }) as FitValuesConfig;
    // 首帧 + 参考图：A 是首帧，B、C 是参考图；fit 的 @图N 只数参考图
    const love = profile("seedance2.0 mini Love");
    const mixed = await canvasToFitValues(love, settings(), "@图片2 的女孩牵着 @图片3 的手，从 @图片1 的画面开始", { firstFrame: image("A"), references: [image("B"), image("C")] });
    assert.equal(mixed.prompt, "@图1 的女孩牵着 @图2 的手，从 @首帧 的画面开始");
    assert.deepEqual(pointsAt(mixed), ["@图1=B", "@图2=C", "@首帧=A"]);
    assert.equal(fitIssueText(validateSubmission(love, mixed)), "");
    // 首尾帧：A 首帧、B 尾帧
    const wan = profile("wan3.0-video");
    const frames = await canvasToFitValues(wan, settings({ vquality: "480P" }), "@图片1 的女孩慢慢走到 @图片2 的位置，镜头跟随", { firstFrame: image("A"), lastFrame: image("B") });
    assert.equal(frames.prompt, "@首帧 的女孩慢慢走到 @尾帧 的位置，镜头跟随");
    assert.deepEqual(pointsAt(frames), ["@首帧=A", "@尾帧=B"]);
    assert.equal(fitIssueText(validateSubmission(wan, frames)), "");
    // 卡片没有首尾帧用途：画布把首帧 A、尾帧 C 追加到参考图 B 后面，编号跟着素材走
    const sea = profile("seedance2.0 SEA");
    const merged = await canvasToFitValues(sea, settings(), "@图片1 回头看着 @图片2，走向 @图片3", { references: [image("B"), image("A"), image("C")] });
    assert.equal(merged.prompt, "@图2 回头看着 @图1，走向 @图3");
    assert.deepEqual(pointsAt(merged), ["@图2=A", "@图1=B", "@图3=C"]);
    assert.equal(fitIssueText(validateSubmission(sea, merged)), "");
});

test("@视频N、@音频N 同样按素材改写；画布标签对不上任何素材时直接报错，不发请求", async () => {
    const prime = profile("wan3.0-video-prime");
    const input = { references: [image("P")], videoReferences: [clip("V1", "video"), clip("V2", "video")], audioReferences: [clip("S", "audio")] };
    const config = { fitMentionLabels: { P: "图片1", V1: "视频1", V2: "视频2", S: "音频1" } } as FitValuesConfig;
    const result = await canvasToFitValues(prime, config, "@视频2 的动作，@图片1 的人物，配上 @音频1 的台词", input);
    assert.equal(result.prompt, "@视频2 的动作，@图1 的人物，配上 @音频1 的台词");
    assert.deepEqual(pointsAt(result), ["@视频2=V2", "@图1=P", "@音频1=S"]);
    await assert.rejects(canvasToFitValues(prime, config, "@视频3 的动作，@图片2 的人物", input), /提示词里引用了 @视频3、@图片2，但没有对应的参考素材/);
});

test("参考视频的片长先实测，测不到才用素材自带的（生成出来的视频节点 durationMs 是生成耗时，不是片长）", async () => {
    const globals = globalThis as { document?: unknown; window?: unknown };
    const saved = { document: globals.document, window: globals.window, hadDocument: "document" in globals, hadWindow: "window" in globals };
    // 浏览器里的 <video> 读出 5 秒
    globals.window = globalThis;
    globals.document = {
        createElement: () => {
            const media: Record<string, unknown> = { removeAttribute() {} };
            Object.defineProperty(media, "src", { set: () => queueMicrotask(() => (Object.assign(media, { duration: 5 }).onloadedmetadata as () => void)()) });
            return media;
        },
    };
    try {
        const gt = profile("seedance 2.5-GT");
        const result = await canvasToFitValues(gt, {}, "@视频1 里的女孩转身微笑，镜头缓慢推进", { videoReferences: [{ ...clip("G", "video", 180_000), name: "video-G.mp4" }] });
        assert.equal(result.references[0].durationSeconds, 5);
        assert.doesNotMatch(fitIssueText(validateSubmission(gt, result)), /180|时长/);
    } finally {
        if (saved.hadDocument) globals.document = saved.document;
        else delete globals.document;
        if (saved.hadWindow) globals.window = saved.window;
        else delete globals.window;
    }
});

test("参考素材按首帧、尾帧、参考图、参考视频、参考音频对应 fit 的角色，带上时长；卡片不收的不读内容、由校验报错", async () => {
    const wan = profile("wan3.0-video");
    const result = await canvasToFitValues(wan, { vquality: "480" }, "@图1 在雨中奔跑", {
        firstFrame: image("first"),
        lastFrame: image("last"),
        references: [image("ref")],
        videoReferences: [{ id: "clip", name: "clip.mp4", type: "video/mp4", url: MP4, durationMs: 5000 }],
        audioReferences: [{ id: "voice", name: "voice.mp3", type: "audio/mpeg", url: MP3, durationMs: 4200 }],
    });
    assert.deepEqual(
        result.references.map(({ kind, role, dataUrl, durationSeconds }) => [kind, role, dataUrl, durationSeconds]),
        [
            ["image", "first_frame", PNG, undefined],
            ["image", "last_frame", PNG, undefined],
            ["image", "reference", PNG, undefined],
            ["video", "reference", MP4, 5],
            ["audio", "reference", MP3, 4.2],
        ],
    );
    assert.ok(fitIssueText(validateSubmission(wan, result)).includes("该模型在 480P 下不支持参考视频"));
});

test("参考视频缺时长时报错（要求时长的卡），有时长就不报", async () => {
    const prime = profile("wan3.0-video-prime");
    const clip = { id: "clip", name: "clip.mp4", type: "video/mp4", url: MP4 };
    const missing = await canvasToFitValues(prime, {}, "@视频1 里的女孩转身", { videoReferences: [clip] });
    assert.equal(missing.references[0].durationSeconds, undefined);
    assert.match(fitIssueText(validateSubmission(prime, missing)), /读不出 clip\.mp4 的时长；视频参考需要/);
    const known = await canvasToFitValues(prime, {}, "@视频1 里的女孩转身", { videoReferences: [{ ...clip, durationMs: 5000 }] });
    assert.doesNotMatch(fitIssueText(validateSubmission(prime, known)), /读不出/);
});

test("fitIssueText 用 fit 的中文文案插值，种类、参数名、用途也译成中文，多条用分号连接", () => {
    const text = fitIssueText([
        { key: "This model does not accept {{kind}} references", values: { kind: "Video" } },
        { key: "This model has no {{role}} slot", values: { role: "first_frame" } },
        { key: "{{field}} must be one of: {{options}}", values: { field: "Seed", options: "auto, low" } },
        { key: "Prompt is required" },
        { key: "Something new from fit" },
    ]);
    assert.equal(text, "该模型不接受视频参考；该模型没有 首帧 这个用途；随机种子 必须为以下选项之一：auto, low；请填写提示词；Something new from fit");
});
