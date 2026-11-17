import assert from "node:assert/strict";
import test from "node:test";
import { classifyFitModels, fitModelKind, type FitCatalog } from "./fit-models";

const catalog: FitCatalog = {
    pricing: [
        { model_name: "seedance-video", supported_endpoint_types: ["openai-video"] },
        { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"] },
        { model_name: "nano-banana", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" },
        { model_name: "claude-sonnet", supported_endpoint_types: ["anthropic", "openai"] },
        { model_name: "placeholder-video", supported_endpoint_types: ["openai-video"] },
        { model_name: "retired-video", supported_endpoint_types: ["openai-video"] },
        { model_name: "undeclared-video", supported_endpoint_types: ["openai-video"] },
        { model_name: "retired-image", supported_endpoint_types: ["image-generation"] },
    ],
    capabilities: {
        models: [
            { id: "seedance-video", kind: "video", family: "url-lists", available: true, visible: true },
            { id: "gpt-image-2", kind: "image", family: "openai-image", available: true, visible: true },
            { id: "nano-banana", kind: "image", family: "gemini-image", available: true, visible: true },
            { id: "placeholder-video", kind: "video", family: "unsupported", available: false, visible: true },
            { id: "retired-video", kind: "video", family: "url-lists", available: false, visible: true },
            { id: "retired-image", kind: "image", family: "openai-image", available: false, visible: true },
        ],
    },
    fetchedAt: "2026-11-01T00:00:00Z",
    stale: false,
};

test("each endpoint type maps to its kind", () => {
    assert.equal(fitModelKind({ id: "a", supported_endpoint_types: ["openai-video"] }), "video");
    assert.equal(fitModelKind({ id: "a", supported_endpoint_types: ["image-generation", "openai", "openai-response"] }), "image");
    for (const endpoint of ["openai", "openai-response", "anthropic", "gemini"]) assert.equal(fitModelKind({ id: "a", supported_endpoint_types: [endpoint] }), "text", endpoint);
    assert.equal(fitModelKind({ id: "a", supported_endpoint_types: ["embeddings"] }), null);
    assert.equal(fitModelKind({ id: "a", supported_endpoint_types: ["jina-rerank"] }), null);
    assert.equal(fitModelKind({ id: "a", supported_endpoint_types: ["image-edits", "openai"] }), "image");
});

test("gemini-endpoint models are images when the name looks like an image model or the price tags say 图像/图片", () => {
    assert.equal(fitModelKind({ id: "gemini-3-pro-image-preview", supported_endpoint_types: ["gemini", "openai"] }), "image");
    assert.equal(fitModelKind({ id: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"] }), "image");
    assert.equal(fitModelKind({ id: "x-1" }, { model_name: "x-1", supported_endpoint_types: ["gemini"], tags: "图片生成" }), "image");
    assert.equal(fitModelKind({ id: "x-2", supported_endpoint_types: ["gemini", "openai"] }, { model_name: "x-2", tags: "图像" }), "image");
    assert.equal(fitModelKind({ id: "gemini-3-pro", supported_endpoint_types: ["gemini", "openai"] }, { model_name: "gemini-3-pro", tags: "文本生成" }), "text");
    assert.equal(fitModelKind({ id: "gpt-image-like", supported_endpoint_types: ["openai"] }), "text");
});

test("a failed catalog still files gemini-nano-banana-2.1 under images", () => {
    const list = classifyFitModels([
        { id: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"] },
        { id: "gemini-3-pro", supported_endpoint_types: ["gemini", "openai"] },
    ], null);
    assert.deepEqual(list.modelCapabilities, { "gemini-nano-banana-2.1": "image", "gemini-3-pro": "text" });
    assert.deepEqual(list.counts, { text: 1, image: 1, video: 0, audio: 0 });
});

test("names containing tts or speech are speech models", () => {
    assert.equal(fitModelKind({ id: "gpt-4o-mini-tts", supported_endpoint_types: ["openai"] }), "audio");
    assert.equal(fitModelKind({ id: "speech-02-hd", supported_endpoint_types: ["openai"] }), "audio");
});

test("the capability catalog kind wins over endpoint types", () => {
    assert.equal(fitModelKind({ id: "nano-banana", supported_endpoint_types: ["gemini", "openai"] }, undefined, { id: "nano-banana", kind: "image" }), "image");
    const list = classifyFitModels([{ id: "nano-banana", supported_endpoint_types: ["gemini", "openai"] }], catalog);
    assert.equal(list.modelCapabilities["nano-banana"], "image");
    assert.equal(list.profiles["nano-banana"]?.imageApi, "gemini-image");
});

test("images and videos follow the fit profile: no fit form hides the model, and the profile decides the kind", () => {
    const tokenModels = [
        { id: "mystery-gem", supported_endpoint_types: ["gemini", "openai"] },
        { id: "wan3.0-video", supported_endpoint_types: ["openai"] },
        { id: "claude-sonnet", supported_endpoint_types: ["anthropic", "openai"] },
    ];
    const list = classifyFitModels(tokenModels, {
        pricing: [
            { model_name: "mystery-gem", supported_endpoint_types: ["gemini", "openai"], tags: "" },
            { model_name: "wan3.0-video", supported_endpoint_types: ["openai"] },
            { model_name: "claude-sonnet", supported_endpoint_types: ["anthropic", "openai"] },
        ],
        capabilities: {
            models: [
                { id: "mystery-gem", kind: "image", family: "gemini-image", available: true, visible: true },
                { id: "wan3.0-video", kind: "video", family: "wan", available: true, visible: true },
            ],
        },
    });
    assert.deepEqual(list.modelCapabilities, { "wan3.0-video": "video", "claude-sonnet": "text" });
    assert.deepEqual(Object.keys(list.profiles), ["wan3.0-video"]);
    assert.equal(list.profiles["wan3.0-video"].referenceMode, "media");
});

test("endpoint types fall back to the price list, then to the model name", () => {
    assert.equal(fitModelKind({ id: "x" }, { model_name: "x", supported_endpoint_types: ["openai-video"] }), "video");
    assert.equal(fitModelKind({ id: "seedance-2.0" }), "video");
    assert.equal(fitModelKind({ id: "gpt-image-2" }), "image");
    assert.equal(fitModelKind({ id: "deepseek-v4" }), "text");
});

test("text models the public price list does not carry still show (gpt-6 group models)", () => {
    const list = classifyFitModels([{ id: "gpt-6-astra", supported_endpoint_types: ["openai", "openai-response"] }], catalog);
    assert.deepEqual(list.modelCapabilities, { "gpt-6-astra": "text" });
});

test("placeholder, missing and withdrawn catalog entries hide images and videos", () => {
    const list = classifyFitModels([
        { id: "seedance-video", supported_endpoint_types: ["openai-video"] },
        { id: "placeholder-video", supported_endpoint_types: ["openai-video"] },
        { id: "undeclared-video", supported_endpoint_types: ["openai-video"] },
        { id: "retired-video", supported_endpoint_types: ["openai-video"] },
        { id: "retired-image", supported_endpoint_types: ["image-generation"] },
        { id: "group-only-image", supported_endpoint_types: ["image-generation"] },
        { id: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"] },
        { id: "text-embedding-3", supported_endpoint_types: ["embeddings"] },
        { id: "claude-sonnet", supported_endpoint_types: ["anthropic", "openai"] },
    ], catalog);
    assert.deepEqual(list.models, ["claude-sonnet", "gpt-image-2", "seedance-video"]);
    assert.deepEqual(list.counts, { text: 1, image: 1, video: 1, audio: 0 });
    assert.deepEqual(Object.keys(list.profiles).sort(), ["gpt-image-2", "seedance-video"]);
});

test("a failed catalog does not block: text shows and images/videos use endpoint types only", () => {
    const list = classifyFitModels([
        { id: "claude-sonnet", supported_endpoint_types: ["anthropic"] },
        { id: "undeclared-video", supported_endpoint_types: ["openai-video"] },
        { id: "group-only-image", supported_endpoint_types: ["image-generation"] },
    ], null);
    assert.deepEqual(list.modelCapabilities, { "claude-sonnet": "text", "undeclared-video": "video", "group-only-image": "image" });
});

test("duplicate and blank ids are dropped", () => {
    const list = classifyFitModels([{ id: "a", supported_endpoint_types: ["openai"] }, { id: "a", supported_endpoint_types: ["openai"] }, { id: " " }], null);
    assert.deepEqual(list.models, ["a"]);
});
