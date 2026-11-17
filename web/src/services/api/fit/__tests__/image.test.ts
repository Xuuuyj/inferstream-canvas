import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";
import { buildModelProfile } from "@/lib/fit-generate/lib/model-profiles";
import { buildRelayRequest } from "@/lib/fit-generate/lib/request-builders";
import { validateSubmission } from "@/lib/fit-generate/lib/validate-submission";
import type { FitCatalog, FitTokenModel } from "@/lib/fit-models";
import { getProxyUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import { fitImageRequest, requestFitImages } from "../image";
import { canvasToFitValues } from "../values";

const PNG_B64 = "iVBORw0KGgo=";
const JPEG_B64 = "/9j/4AAQSkZJRg==";
const PNG = `data:image/png;base64,${PNG_B64}`;

/**
 * 字段取自 2026-11-01 openai.fit 的 /api/pricing 和 /api/model-capabilities（只保留用到的）。
 * 和 catalog.test.ts 里这两张卡的字段一致：/api/fit/catalog 在模块里缓存 60 秒，同一进程里先跑的测试留下的目录也能用。
 */
const PRICING = [
    { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"], tags: "图像生成,GPT Image" },
    { model_name: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" },
];
const CATALOG: FitCatalog = {
    pricing: PRICING,
    capabilities: {
        schemaVersion: 1,
        revision: "r-20261101",
        models: [
            { id: "gpt-image-2", kind: "image", family: "openai-image", available: true, visible: true },
            { id: "gemini-nano-banana-2.1", kind: "image", family: "gemini-image", available: true, visible: true },
        ],
    },
    fetchedAt: 1_793_500_000,
    stale: false,
};
const TOKEN_MODELS: FitTokenModel[] = PRICING.map((entry) => ({ id: entry.model_name, supported_endpoint_types: entry.supported_endpoint_types }));

type Call = { url: string; method: string; authorization: string; credentials: string; body: unknown };

let keys = 0;

/** 接管 fetch（/v1/models 直接回令牌模型，其余请求交给 handler 并记下来）和 /api/fit/catalog 的 axios；每个用例换一把令牌，避开 60 秒缓存。 */
async function withFit(handler: (call: Call) => Response | Promise<Response>, run: (calls: Call[], config: (extra: Partial<AiConfig>) => AiConfig) => Promise<void>) {
    const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter };
    const apiKey = `sk-image-test-${++keys}`;
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://openai.fit/v1/models") return Response.json({ success: true, object: "list", data: TOKEN_MODELS });
        const call = { url, method: init?.method || "GET", authorization: new Headers(init?.headers).get("Authorization") || "", credentials: String(init?.credentials), body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body };
        calls.push(call);
        return handler(call);
    }) as typeof fetch;
    const adapter: AxiosAdapter = async (config) => ({ data: { code: 0, data: CATALOG, msg: "" }, status: 200, statusText: "", headers: {}, config });
    axios.defaults.adapter = adapter;
    // 三把令牌各不相同：出图的每个请求（上传参考图、生成、读结果图、备份图）都只能带图片令牌
    const slot = (tokenId: number, key: string) => ({ tokenId, name: `令牌${tokenId}`, group: "", apiKey: key });
    const fitKeys = { image: slot(1, apiKey), video: slot(2, `${apiKey}-video`), text: slot(3, `${apiKey}-text`) };
    const config = (extra: Partial<AiConfig>) => ({ fitKeys, fitManualKey: "", model: "gpt-image-2", size: "1:1", quality: "auto", systemPrompt: "", systemPrompts: { image: "", video: "" }, ...extra }) as AiConfig;
    try {
        await run(calls, config);
    } finally {
        globalThis.fetch = original.fetch;
        axios.defaults.adapter = original.adapter;
    }
}

const bytes = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];
const decoded = (base64: string) => [...Buffer.from(base64, "base64")];

test("张数为 3 时并发发出 3 个单张请求，每个 n 都是 1；带 Bearer、不带 Cookie", async () => {
    await withFit(
        () => Response.json({ data: [{ b64_json: PNG_B64 }] }),
        async (calls, config) => {
            const blobs = await requestFitImages(config({}), "漫剧分镜：女孩走进校门", [], 3);
            assert.equal(blobs.length, 3);
            assert.equal(calls.length, 3);
            for (const call of calls) {
                assert.equal(call.url, "https://openai.fit/v1/images/generations");
                assert.equal(call.method, "POST");
                assert.equal((call.body as { n?: number }).n, 1);
                assert.equal((call.body as { model?: string }).model, "gpt-image-2");
                assert.equal(call.authorization, `Bearer ${config({}).fitKeys.image!.apiKey}`);
                assert.equal(call.credentials, "omit");
            }
        },
    );
});

test("b64 结果转成 Blob：OpenAI 的 b64_json 和 Gemini 的 inlineData 都按原字节、带 MIME", async () => {
    await withFit(
        (call) => (call.url.includes(":generateContent") ? Response.json({ candidates: [{ content: { parts: [{ text: "好的" }, { inlineData: { mimeType: "image/jpeg", data: JPEG_B64 } }] } }] }) : Response.json({ data: [{ b64_json: PNG_B64 }] })),
        async (calls, config) => {
            const [png] = await requestFitImages(config({}), "画一只猫", [], 1);
            assert.ok(png instanceof Blob);
            assert.equal(png.type, "image/png");
            assert.deepEqual(await bytes(png), decoded(PNG_B64));
            const [jpeg] = await requestFitImages(config({ model: "gemini-nano-banana-2.1", size: "16:9", quality: "medium" }), "画一只猫", [], 1);
            assert.equal(jpeg.type, "image/jpeg");
            assert.deepEqual(await bytes(jpeg), decoded(JPEG_B64));
            const gemini = calls.find((call) => call.url.includes(":generateContent"));
            assert.equal(gemini?.url, "https://openai.fit/v1beta/models/gemini-nano-banana-2.1:generateContent");
            assert.deepEqual((gemini?.body as { generationConfig?: unknown }).generationConfig, { candidateCount: 1, responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "16:9", imageSize: "2K" } });
        },
    );
});

test("返回链接：fit 以外的主机走同源 /api/proxy-image，openai.fit 和 OSS 桶浏览器直接取", async () => {
    const upstream = "https://cdn.upstream.example/out/a.png?sig=1";
    const fitLink = "https://openai.fit/v1/tasks/img-1/artifacts/0/content?access=x";
    const ossLink = "https://fadacai-openai-fit.oss-cn-shenzhen.aliyuncs.com/media/a.png?Signature=y";
    await withFit(
        (call) => {
            if (call.method === "POST") return Response.json({ data: [{ url: upstream }, { url: fitLink }, { url: ossLink }] });
            return new Response(new Blob([Buffer.from(PNG_B64, "base64")], { type: "image/png" }), { headers: { "content-type": "image/png" } });
        },
        async (calls, config) => {
            const blobs = await requestFitImages(config({}), "画一只猫", [], 1);
            assert.equal(blobs.length, 3);
            const reads = calls.filter((call) => call.method === "GET");
            assert.deepEqual(
                reads.map((call) => call.url),
                [`/api/proxy-image?url=${encodeURIComponent(upstream)}`, fitLink, ossLink],
            );
            assert.ok(!calls.some((call) => call.url.startsWith("https://cdn.upstream.example")));
            // 令牌只发给 openai.fit 本身；OSS 链接不带令牌，两者都不带 Cookie
            assert.equal(reads[1].authorization, `Bearer ${config({}).fitKeys.image!.apiKey}`);
            assert.deepEqual([reads[1].credentials, reads[2].credentials, reads[2].authorization], ["omit", "omit", ""]);
        },
    );
});

test("出图只用图片令牌：没选图片令牌时不发请求，提示先选图片令牌（视频、文本令牌不顶替）", async () => {
    await withFit(
        () => Response.json({ data: [{ b64_json: PNG_B64 }] }),
        async (calls, config) => {
            const { image: _image, ...others } = config({}).fitKeys;
            await assert.rejects(requestFitImages(config({ fitKeys: others }), "画一只猫", [], 1), { message: "缺少可用的图片令牌，请在设置中查看模型服务状态" });
            assert.equal(calls.length, 0);
            await requestFitImages(config({}), "画一只猫", [], 2);
            assert.deepEqual(new Set(calls.map((call) => call.authorization)), new Set([`Bearer ${config({}).fitKeys.image!.apiKey}`]));
            // 手动令牌优先，三类都用它
            calls.length = 0;
            await requestFitImages(config({ fitManualKey: "sk-manual-image-0123456789" }), "画一只猫", [], 1);
            assert.deepEqual(calls.map((call) => call.authorization), ["Bearer sk-manual-image-0123456789"]);
        },
    );
});

test("getProxyUrl：openai.fit 和 fit 的 OSS 桶返回原链接，其他主机和 http 的 openai.fit 走代理", () => {
    for (const url of ["https://openai.fit/v1/videos/abc/content", "https://openai.fit/v1/tasks/x/artifacts/0/content?access=y", "https://fadacai-openai-fit.oss-cn-shenzhen.aliyuncs.com/media/a.mp4?Signature=z", "data:image/png;base64,AA=="]) {
        assert.equal(getProxyUrl(url), url);
    }
    for (const url of ["https://cdn.upstream.example/a.png", "http://openai.fit/a.png", "https://evil.openai.fit.example/a.png", "https://other-bucket.oss-cn-shenzhen.aliyuncs.com/a.png"]) {
        assert.equal(getProxyUrl(url), `/api/proxy-image?url=${encodeURIComponent(url)}`);
    }
});

test("结果图读不到时，按 X-Oneapi-Request-Id 取 fit 的备份图（带令牌、不带 Cookie）；没有请求 id 就报原来的错", async () => {
    const upstream = "https://cdn.upstream.example/out/a.png";
    await withFit(
        (call) => {
            if (call.method === "POST") return Response.json({ data: [{ url: upstream }] }, { headers: { "X-Oneapi-Request-Id": "20261101/abc 123" } });
            if (call.url.startsWith("/api/proxy-image")) return Response.json({ code: 1, msg: "上游拒绝" }, { status: 502 });
            return new Response(new Blob([Buffer.from(JPEG_B64, "base64")], { type: "image/jpeg" }));
        },
        async (calls, config) => {
            const [blob] = await requestFitImages(config({}), "画一只猫", [], 1);
            assert.deepEqual(await bytes(blob), decoded(JPEG_B64));
            const backup = calls.at(-1);
            assert.equal(backup?.url, "https://openai.fit/v1/tasks/img-20261101-abc-123/artifacts/0/content");
            assert.equal(backup?.authorization, `Bearer ${config({}).fitKeys.image!.apiKey}`);
            assert.equal(backup?.credentials, "omit");
        },
    );
    await withFit(
        (call) => (call.method === "POST" ? Response.json({ data: [{ url: upstream }] }) : new Response("bad gateway", { status: 502 })),
        async (calls, config) => {
            await assert.rejects(requestFitImages(config({}), "画一只猫", [], 1), /读取生成的图片失败：502/);
            assert.ok(!calls.some((call) => call.url.includes("/v1/tasks/")));
        },
    );
});

test("校验不通过、模型不能出图、@ 了没有的参考图时一个生成请求都不发；带参考图走 multipart 改图，@图片N 改成 @图N", async () => {
    await withFit(
        () => Response.json({ data: [{ b64_json: PNG_B64 }] }),
        async (calls, config) => {
            await assert.rejects(requestFitImages(config({}), "   ", [], 3), /提示词/);
            await assert.rejects(requestFitImages(config({}), "把 @图片3 的外套换成红色", [{ id: "r1", name: "r1.png", type: "image/png", dataUrl: PNG }], 1), /提示词里引用了 @图片3，但没有对应的参考素材/);
            await assert.rejects(requestFitImages(config({ model: "seedance-2.0-mini-super" }), "画一只猫", [], 1), /不能用 seedance-2.0-mini-super 出图/);
            assert.equal(calls.length, 0);
            await requestFitImages(config({ size: "1024x1536" }), "@图片1 换成红色外套", [{ id: "r1", name: "r1.png", type: "image/png", dataUrl: PNG }], 2);
            assert.equal(calls.length, 2);
            for (const call of calls) {
                assert.equal(call.url, "https://openai.fit/v1/images/edits");
                assert.ok(call.body instanceof FormData);
                assert.equal(call.body.get("n"), "1");
                assert.equal(call.body.get("size"), "1024x1536");
                assert.equal(call.body.get("prompt"), "@图1 换成红色外套");
                assert.equal(call.body.getAll("image").length, 1);
            }
        },
    );
});

test("停止后不再等结果：已发出的请求照常扣费，这里只是立即报停止", async () => {
    let release = () => {};
    await withFit(
        () =>
            new Promise<Response>((resolve) => {
                release = () => resolve(Response.json({ data: [{ b64_json: PNG_B64 }] }));
            }),
        async (calls, config) => {
            const controller = new AbortController();
            const pending = requestFitImages(config({}), "画一只猫", [], 1, controller.signal);
            while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 5));
            controller.abort(new Error("已停止"));
            await assert.rejects(pending, /已停止/);
            release();
        },
    );
});

/** 2026-11-01 openai.fit 在售的 7 张图片卡（/api/pricing 的字段）。 */
const ON_SALE_IMAGE_CARDS = [
    { model_name: "gpt-image-2", supported_endpoint_types: ["image-generation", "openai"], tags: "图像生成,GPT Image" },
    { model_name: "gpt-image-2-1K-4K", supported_endpoint_types: ["image-generation", "openai", "image-edits"], tags: "图像生成,GPT Image,1K,2K,4K" },
    { model_name: "gpt-image-2-codex", supported_endpoint_types: ["image-generation", "openai", "openai-response", "openai-response-compact", "anthropic", "gemini", "openai-alpha-search"], tags: "图像生成,GPT Image" },
    { model_name: "gpt-image-2-codex-MAX", supported_endpoint_types: ["image-generation", "openai", "image-edits"], tags: "图像生成,GPT Image" },
    { model_name: "gemini-nano-banana-2.1", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" },
    { model_name: "gemini-3-pro-image-preview", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" },
    { model_name: "gemini-3.1-flash-image-preview", supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" },
];

test("出图走 fit 生成台 runner 的流程（只留卡片收的素材 → 补边 → 托管 → 构造请求）：今天在售的 7 张图片卡请求体和直接 buildRelayRequest 逐字一致、不发上传", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => Promise.reject(new Error(`unexpected request ${String(input)}`))) as typeof fetch;
    try {
        for (const card of ON_SALE_IMAGE_CARDS) {
            const profile = buildModelProfile(card);
            assert.ok(profile?.kind === "image", card.model_name);
            const references = profile.referenceTypes.includes("image") ? [{ id: "r1", name: "r1.png", type: "image/png", dataUrl: PNG }] : [];
            for (const config of [
                { size: "16:9", quality: "high" },
                { size: "1024x1536", quality: "2K" },
            ]) {
                const values = await canvasToFitValues(profile, config, references.length ? "@图片1 换成红色外套" : "画一只猫", { references });
                assert.deepEqual(validateSubmission(profile, values), [], card.model_name);
                assert.deepEqual(await fitImageRequest(profile, values, "sk-image-parity"), buildRelayRequest(profile, values), card.model_name);
            }
        }
    } finally {
        globalThis.fetch = original;
    }
});

test("图片卡要托管参考图时（fit 以后给图片卡加上），先传 /v1/uploads（带 Bearer、不带 Cookie），请求体里换成返回的 https 链接", async () => {
    const card = buildModelProfile(ON_SALE_IMAGE_CARDS[1]);
    assert.ok(card);
    const hosted = { ...card, imageEditTransport: "json" as const, limits: { ...card.limits, hostedKinds: ["image" as const] } };
    await withFit(
        (call) => {
            const file = (call.body as FormData).get("file") as File;
            return Response.json({ url: `https://openai.fit/uploads/${file.name}`, expires_at: Math.floor(Date.now() / 1000) + 72 * 3600 });
        },
        async (calls, config) => {
            const apiKey = config({}).fitKeys.image!.apiKey;
            const values = await canvasToFitValues(hosted, { size: "1024x1536" }, "@图片1 换成红色外套", { references: [{ id: "r1", name: "r1.png", type: "image/png", dataUrl: PNG }] });
            const request = await fitImageRequest(hosted, values, apiKey);
            assert.deepEqual(
                calls.map((call) => [call.url, call.authorization, call.credentials]),
                [["https://openai.fit/v1/uploads", `Bearer ${apiKey}`, "omit"]],
            );
            assert.ok(request.transport === "json");
            assert.deepEqual(request.body.images, [{ image_url: "https://openai.fit/uploads/r1.png" }]);
            assert.doesNotMatch(JSON.stringify(request.body), /data:image/);
        },
    );
});
