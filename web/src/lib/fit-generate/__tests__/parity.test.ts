import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_VIDEO_RULES } from "../constants";
import { capabilityLookup, parseCapabilityFeed } from "../lib/capability-feed";
import { buildStudioModels, defaultFormValuesFor } from "../lib/model-profiles";
import { getVideoTask } from "../lib/relay-client";
import { buildRelayRequest } from "../lib/request-builders";
import { validateSubmission } from "../lib/validate-submission";
import contracts from "../model-capabilities.json";
import type { PricingModel } from "../shims/pricing-types";
import golden from "../testdata/studio-declared-entries.golden.json";
import type { GenerationFormValues, ReferenceAssetKind, ReferenceImage, StudioModel } from "../types";

/** 快照由 UPDATE_FIT_SNAPSHOT=1 bun test 本文件写出；重新同步 fit 后请求体变了，先核对再更新。 */
const SNAPSHOT = fileURLToPath(new URL("./parity.snapshot.json", import.meta.url));
const PROMPT = "漫剧分镜：穿灰色衬衫的女孩走进校门，回头微笑，镜头缓慢推进。";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const MIME: Record<ReferenceAssetKind, string> = { image: "image/png", video: "video/mp4", audio: "audio/mpeg" };

function ref(kind: ReferenceAssetKind, index: number, extra: Partial<ReferenceImage> = {}): ReferenceImage {
    return { id: `${kind}-${index}`, name: `${kind}-${index}`, kind, role: "reference", mimeType: MIME[kind], dataUrl: `https://openai.fit/v1/uploads/${kind}-${index}`, ...extra };
}

function video(model_name: string, resolutions?: string[]): PricingModel {
    return { model_name, supported_endpoint_types: ["openai-video"], billing_usage_schema: resolutions ? { resolution: { enum: resolutions } } : undefined };
}

function form({ profile }: StudioModel, overrides: Partial<GenerationFormValues> = {}): GenerationFormValues {
    return { ...defaultFormValuesFor(profile), prompt: PROMPT, references: [], ...overrides };
}

/** 6 张代表卡（价目表字段取自 2026-11-01 的 openai.fit /api/pricing），覆盖 url-lists、content、numbered、media、OpenAI 改图、Gemini 出图。 */
const CARDS: Array<[PricingModel, Partial<GenerationFormValues>]> = [
    [video("seedance-2.0-mini-super", ["480p", "720p", "1080p"]), { aspectRatio: "16:9", references: [ref("image", 1), ref("image", 2), ref("audio", 1)] }],
    [video("seedance 2.0 fast-GT", ["480p", "720p"]), { seconds: 10, resolution: "720p", aspectRatio: "16:9", references: [ref("image", 1), ref("video", 1, { durationSeconds: 5 }), ref("audio", 1, { durationSeconds: 5 })] }],
    [video("minimax H3-self", ["480p竖", "768p竖", "480p横", "768p横"]), { seconds: 6, resolution: "768p横", references: [ref("image", 1, { dataUrl: PNG }), ref("image", 2, { dataUrl: PNG })] }],
    [video("wan3.0-video", ["480P", "720P", "1080P"]), { seconds: 8, aspectRatio: "16:9", references: [ref("image", 1, { role: "first_frame" }), ref("image", 2, { role: "last_frame" })] }],
    [{ model_name: "gpt-image-2-codex-MAX", supported_endpoint_types: ["image-generation", "openai", "image-edits"], tags: "图像生成,GPT Image" }, { imageSize: "1024x1536", references: [ref("image", 1, { dataUrl: PNG })] }],
    [{ model_name: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" }, { aspectRatio: "16:9", imageSize: "2K", references: [ref("image", 1, { dataUrl: PNG })] }],
];

test("golden 里每一条声明（原名和改成没有审核规则的名字）都能 buildStudioModels → defaultFormValuesFor → buildRelayRequest", () => {
    const declared = golden.models.map((entry, index) => ({ ...entry, id: `golden-declared-video-${index + 1}`, name: `golden-declared-video-${index + 1}` }));
    const feed = parseCapabilityFeed({ ...golden, models: [...golden.models, ...declared] });
    const studio = buildStudioModels(feed.models.map((entry) => video(entry.id)), capabilityLookup(feed));
    assert.equal(studio.length, golden.models.length * 2);
    for (const model of studio) {
        const request = buildRelayRequest(model.profile, form(model));
        assert.equal(request.transport === "json" && request.body.model, model.profile.modelName);
    }
    for (const entry of declared) assert.equal(studio.find((model) => model.profile.modelName === entry.id)?.profile.referenceMode, "url-lists", entry.id);
});

test("KNOWN_VIDEO_RULES 和打包能力清单里的每张视频卡，用默认值都能构造请求", () => {
    const names = new Set([...Object.keys(KNOWN_VIDEO_RULES), ...contracts.filter((entry) => entry.kind === "video").map((entry) => entry.id)]);
    const studio = buildStudioModels([...names].map((name) => video(name)), null);
    assert.equal(studio.length, names.size);
    for (const model of studio) assert.doesNotThrow(() => buildRelayRequest(model.profile, form(model)), model.profile.modelName);
});

const actual = Object.fromEntries(
    CARDS.map(([pricing, overrides]) => {
        const [model] = buildStudioModels([pricing], null);
        const values = form(model, overrides);
        assert.deepEqual(validateSubmission(model.profile, values), [], pricing.model_name);
        return [pricing.model_name, buildRelayRequest(model.profile, values)];
    }),
);
if (process.env.UPDATE_FIT_SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(actual, null, 4) + "\n");
const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

for (const [name, request] of Object.entries(actual)) {
    test(`代表卡 ${name} 的请求体和快照一致`, () => assert.deepEqual(request, snapshot[name]));
}

test("同步副本里的 fetch 换成了 fitFetch：拼上 https://openai.fit、不带 Cookie、带 Bearer", async () => {
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push([input, init]);
        return new Response(JSON.stringify({ status: "in_progress", progress: 40 }), { status: 200 });
    }) as typeof fetch;
    try {
        assert.deepEqual(await getVideoTask("task 1", "sk-test"), { status: "in_progress", progress: 40, error: null });
    } finally {
        globalThis.fetch = original;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], "https://openai.fit/v1/videos/task%201");
    assert.equal(calls[0][1]?.credentials, "omit");
    assert.deepEqual(calls[0][1]?.headers, { Authorization: "Bearer sk-test" });
});
