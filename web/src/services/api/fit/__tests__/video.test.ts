import assert from "node:assert/strict";
import test from "node:test";
import axios, { type AxiosAdapter } from "axios";
import type { FitCatalog, FitTokenModel } from "@/lib/fit-models";
import { acceptedReferences, buildRelayRequest } from "@/lib/fit-generate/lib/request-builders";
import type { VideoResponse } from "@/services/api/video";
import { loadFitStudio } from "../catalog";
import { canvasToFitValues } from "../values";
import { createFitVideoTask, pollFitVideoTask, type FitVideoConfig } from "../video";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const MP4 = "data:video/mp4;base64,AAAAIGZ0eXA=";
const VIDEO_BYTES = new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]);
const ACCESS = "A".repeat(43);

/** 两张打包规则里的代表卡：seedance2.0 SEA（url-lists，只收参考图）、wan3.0-video（media，首尾帧，图片要托管）。 */
const TOKEN_MODELS: FitTokenModel[] = [
    { id: "seedance2.0 SEA", supported_endpoint_types: ["openai-video"] },
    { id: "wan3.0-video", supported_endpoint_types: ["openai-video"] },
];
const CATALOG: FitCatalog = {
    pricing: TOKEN_MODELS.map((model) => ({ model_name: model.id, supported_endpoint_types: ["openai-video"], tags: "视频生成" })),
    capabilities: null,
    fetchedAt: 1_793_500_000,
    stale: false,
};

type Call = { url: string; method: string; authorization: string; contentType: string; credentials: string; body: BodyInit | null | undefined };
type Route = (call: Call, init?: RequestInit) => Response | Promise<Response>;

let clock = Date.now() + 30 * 24 * 3600_000;
let keySeq = 0;

/** 每个用例换一把令牌、时钟拨快 2 分钟（目录缓存过期），接管全局 fetch（fitFetch 最终调它）和 /api/fit/catalog 的 axios。 */
async function withFit(routes: Record<string, Route>, run: (ctx: { calls: Call[]; apiKey: string }) => Promise<void>) {
    const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter, now: Date.now };
    clock += 120_000;
    Date.now = () => clock;
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const call = { url: String(input), method: init?.method || "GET", authorization: headers.get("Authorization") || "", contentType: headers.get("Content-Type") || "", credentials: String(init?.credentials), body: init?.body };
        if (call.url === "https://openai.fit/v1/models") return Response.json({ success: true, object: "list", data: TOKEN_MODELS });
        calls.push(call);
        const route = routes[`${call.method} ${call.url.replace(/\?.*$/, "")}`];
        if (!route) throw new Error(`unexpected request ${call.method} ${call.url}`);
        return route(call, init);
    }) as typeof fetch;
    const adapter: AxiosAdapter = async (config) => ({ data: { code: 0, data: CATALOG, msg: "" }, status: 200, statusText: "", headers: {}, config });
    axios.defaults.adapter = adapter;
    try {
        await run({ calls, apiKey: `sk-video-${++keySeq}` });
    } finally {
        globalThis.fetch = original.fetch;
        axios.defaults.adapter = original.adapter;
        Date.now = original.now;
    }
}

const slot = (tokenId: number, apiKey: string) => ({ tokenId, name: `令牌${tokenId}`, group: "", apiKey });
/** 只选了视频令牌（id 11）的配置；loadFitStudio 用同一组令牌（videoKeys）才命中同一份缓存。 */
const config = (apiKey: string, model: string, extra: Partial<FitVideoConfig> = {}): FitVideoConfig => ({ fitKeys: { video: slot(11, apiKey) }, fitManualKey: "", model, videoModel: model, ...extra });
const videoKeys = (apiKey: string) => ({ video: apiKey, image: "", text: "" });
const keyConfig = (apiKey: string) => ({ fitKeys: { video: slot(11, apiKey) }, fitManualKey: "" });
/** 内容不同的两张图（fit 的上传按内容 SHA-256 去重，同样的字节只传一次）。 */
const image = (id: string, dataUrl = PNG) => ({ id, name: `${id}.png`, type: "image/png", dataUrl });
const videoResponse = () => new Response(new Blob([VIDEO_BYTES], { type: "video/mp4" }), { headers: { "Content-Type": "video/mp4" } });

test("校验不通过时直接报中文原因，一个生成或上传请求都不发", async () => {
    await withFit({}, async ({ calls, apiKey }) => {
        await loadFitStudio(videoKeys(apiKey));
        await assert.rejects(createFitVideoTask(config(apiKey, "seedance2.0 SEA"), "   ", {}), /请填写提示词/);
        await assert.rejects(createFitVideoTask(config(apiKey, "seedance2.0 SEA"), "漫剧分镜：女孩走进校门", { videoReferences: [{ id: "v1", name: "clip.mp4", type: "video/mp4", url: MP4, durationMs: 4000 }] }), /不接受视频参考/);
        assert.deepEqual(calls, []);
    });
});

test("请求体和 buildRelayRequest 的输出完全一致：POST https://openai.fit/v1/videos，带 Bearer，不带 Cookie", async () => {
    await withFit({ "POST https://openai.fit/v1/videos": () => Response.json({ id: "task_sea_1", object: "video", status: "queued", progress: 0 }) }, async ({ calls, apiKey }) => {
        const settings = config(apiKey, "seedance2.0 SEA", { videoSeconds: "8", vquality: "720", size: "1280x720", systemPrompts: { image: "", video: "电影感" } as FitVideoConfig["systemPrompts"] });
        const progress: number[] = [];
        const created = await createFitVideoTask(settings, "女孩走进校门", {}, undefined, (value) => progress.push(value));
        const profile = (await loadFitStudio(videoKeys(apiKey))).profiles["seedance2.0 SEA"];
        const expected = buildRelayRequest(profile, await canvasToFitValues(profile, settings, "女孩走进校门"));
        assert.equal(calls.length, 1);
        const [post] = calls;
        assert.equal(post.url, "https://openai.fit/v1/videos");
        assert.equal(post.authorization, `Bearer ${apiKey}`);
        assert.equal(post.credentials, "omit");
        assert.equal(post.contentType, "application/json");
        assert.ok(expected.transport === "json");
        assert.deepEqual(JSON.parse(String(post.body)), expected.body);
        assert.deepEqual(created.requestBody, expected.body);
        assert.equal((expected.body as { prompt: string }).prompt, "电影感\n\n女孩走进校门");
        assert.deepEqual(created.task, { id: "task_sea_1", task_id: "task_sea_1", model: "seedance2.0 SEA", status: "queued", progress: 0, fitKeyRef: "t:11" });
        assert.equal(created.pollId, "task_sea_1");
        assert.deepEqual(progress, [0]);
    });
});

test("要托管的参考素材先传到 /v1/uploads，请求体里换成返回的 https 链接，其余和 buildRelayRequest 一致", async () => {
    const uploaded: string[] = [];
    await withFit(
        {
            "POST https://openai.fit/v1/uploads": (call) => {
                const file = (call.body as FormData).get("file") as File;
                uploaded.push(file.name);
                return Response.json({ url: `https://openai.fit/uploads/${file.name}`, expires_at: Math.floor(clock / 1000) + 72 * 3600 });
            },
            "POST https://openai.fit/v1/videos": () => Response.json({ id: "task_wan_1", status: "queued" }),
        },
        async ({ calls, apiKey }) => {
            // wan3.0-video 的尾帧只在 480P 下可用（720P 会被 validateSubmission 拦下）
            const settings = config(apiKey, "wan3.0-video", { videoSeconds: "6", vquality: "480p", size: "16:9" });
            const input = { firstFrame: image("first"), lastFrame: image("last", "data:image/png;base64,iVBORw0KGgoB") };
            await createFitVideoTask(settings, "镜头缓慢推进，女孩回头", input);
            const profile = (await loadFitStudio(videoKeys(apiKey))).profiles["wan3.0-video"];
            const values = await canvasToFitValues(profile, settings, "镜头缓慢推进，女孩回头", input);
            const hosted = acceptedReferences(profile, values.references).map((asset) => ({ ...asset, dataUrl: `https://openai.fit/uploads/${asset.name}` }));
            const expected = buildRelayRequest(profile, { ...values, references: hosted });
            assert.deepEqual([...uploaded].sort(), ["first.png", "last.png"]);
            assert.ok(calls.filter((call) => call.url.endsWith("/v1/uploads")).every((call) => call.authorization === `Bearer ${apiKey}` && call.credentials === "omit"));
            const post = calls.find((call) => call.url === "https://openai.fit/v1/videos");
            assert.ok(expected.transport === "json" && post);
            assert.deepEqual(JSON.parse(String(post.body)), expected.body);
            assert.doesNotMatch(String(post.body), /data:image/);
        },
    );
});

test("已经取消的提交不上传、不发生成请求", async () => {
    await withFit({}, async ({ calls, apiKey }) => {
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(createFitVideoTask(config(apiKey, "wan3.0-video"), "女孩回头", { firstFrame: image("first") }, controller.signal), { name: "AbortError" });
        assert.deepEqual(calls, []);
    });
});

test("轮询状态对应：queued → queued，in_progress → processing，failed 带原因；画布自己的 client_ 任务号不去 fit 查", async () => {
    const states: Record<string, object> = {
        task_q: { id: "task_q", status: "queued", progress: 0 },
        task_p: { id: "task_p", status: "in_progress", progress: 42 },
        task_f: { id: "task_f", status: "failed", progress: 100, error: { message: "生成失败，请联系管理员" } },
    };
    const routes = Object.fromEntries(Object.entries(states).map(([id, state]) => [`GET https://openai.fit/v1/videos/${id}`, () => Response.json(state)]));
    await withFit(routes, async ({ calls, apiKey }) => {
        const poll = (id: string) => pollFitVideoTask(keyConfig(apiKey), { id, task_id: id, model: "seedance2.0 SEA", status: "loading" });
        assert.deepEqual(await poll("task_q"), { id: "task_q", task_id: "task_q", model: "seedance2.0 SEA", status: "queued", progress: 0 });
        assert.deepEqual(await poll("task_p"), { id: "task_p", task_id: "task_p", model: "seedance2.0 SEA", status: "processing", progress: 42 });
        const failed = await poll("task_f");
        assert.equal(failed.status, "failed");
        assert.equal(failed.error?.message, "生成失败，请联系管理员");
        assert.ok(calls.every((call) => call.authorization === `Bearer ${apiKey}` && call.credentials === "omit"));
        // 提交还没返回时画布轮询到的是 client_ 号：不发请求、抛错让画布忽略这一轮（返回旧任务会把节点上的 fit 任务号改回去）
        const pending: VideoResponse = { id: "client_video_task_x", task_id: "client_video_task_x", status: "loading" };
        const before = calls.length;
        await assert.rejects(pollFitVideoTask(keyConfig(apiKey), pending), /还在提交/);
        assert.equal(calls.length, before);
    });
});

test("完成后带 Bearer、credentials:omit 下载一次 /content 存进浏览器，返回本地地址", async () => {
    const saved: Array<{ blob: Blob; remoteId: string }> = [];
    const save = async (blob: Blob, remoteId: string) => {
        saved.push({ blob, remoteId });
        return { url: "blob:local-video", storageKey: "generated-video:abc", width: 720, height: 1280 };
    };
    await withFit(
        {
            "GET https://openai.fit/v1/videos/task_c": () => Response.json({ id: "task_c", status: "completed", progress: 100 }),
            "GET https://openai.fit/v1/videos/task_c/content": () => videoResponse(),
        },
        async ({ calls, apiKey }) => {
            const done = await pollFitVideoTask(keyConfig(apiKey), { id: "task_c", task_id: "task_c", status: "processing" }, undefined, save);
            assert.equal(done.status, "completed");
            assert.equal(done.video_url, "blob:local-video");
            assert.equal(done.url, "blob:local-video");
            assert.equal(done.storageKey, "generated-video:abc");
            // 成片宽高走画布的 mediaSize（只定节点框和 naturalWidth/Height），不写 size：用户选的画幅（例如 adaptive）留在节点上，下次照样发
            assert.equal(done.size, undefined);
            assert.deepEqual(done.mediaSize, { content: "blob:local-video", width: 720, height: 1280 });
            const content = calls.filter((call) => call.url.endsWith("/content"));
            assert.equal(content.length, 1);
            assert.equal(content[0].authorization, `Bearer ${apiKey}`);
            assert.equal(content[0].credentials, "omit");
            assert.equal(saved.length, 1);
            assert.equal(saved[0].remoteId, "task_c");
            assert.equal(saved[0].blob.type, "video/mp4");
            assert.deepEqual(new Uint8Array(await saved[0].blob.arrayBuffer()), VIDEO_BYTES);
            // 节点上选的是 adaptive：出片后任务里的 size 仍是 adaptive（画布的 applyCanvasVideoTaskUpdate 写回 task.size || node.size）
            const adaptive = await pollFitVideoTask(keyConfig(apiKey), { id: "task_c", task_id: "task_c", status: "processing", size: "adaptive" }, undefined, save);
            assert.equal(adaptive.size, "adaptive");
        },
    );
});

test("/content 失败（下载次数受限）时走签名链接：不带令牌下载存进浏览器；签名链接也读不到时直接交给播放器", async () => {
    const signed = `https://openai.fit/v1/tasks/task_s/artifacts/video/content?access=${ACCESS}`;
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window ??= { location: { protocol: "https:" } };
    let signedWorks = true;
    const saved: string[] = [];
    const save = async (blob: Blob, remoteId: string) => {
        saved.push(`${remoteId}:${blob.size}`);
        return { url: "blob:from-signed", storageKey: "generated-video:signed" };
    };
    try {
        await withFit(
            {
                "GET https://openai.fit/v1/videos/task_s": () => Response.json({ id: "task_s", status: "completed", progress: 100 }),
                "GET https://openai.fit/v1/videos/task_s/content": () => Response.json({ error: { code: "artifact_download_limited", message: "This artifact was downloaded too many times" } }, { status: 429 }),
                "GET https://openai.fit/v1/tasks/task_s/artifacts": () => Response.json({ task_id: "task_s", artifacts: [{ key: "video", type: "video", content_url: signed }] }),
                "GET https://openai.fit/v1/tasks/task_s/artifacts/video/content": () => {
                    if (!signedWorks) throw new TypeError("Failed to fetch");
                    return videoResponse();
                },
            },
            async ({ calls, apiKey }) => {
                const done = await pollFitVideoTask(keyConfig(apiKey), { id: "task_s", task_id: "task_s" }, undefined, save);
                assert.equal(done.video_url, "blob:from-signed");
                assert.equal(done.storageKey, "generated-video:signed");
                assert.deepEqual(saved, [`task_s:${VIDEO_BYTES.length}`]);
                const signedCall = calls.find((call) => call.url === signed);
                assert.ok(signedCall);
                assert.equal(signedCall.authorization, "");
                assert.equal(signedCall.credentials, "omit");
                assert.equal(calls.find((call) => call.url.endsWith("/v1/tasks/task_s/artifacts"))?.authorization, `Bearer ${apiKey}`);

                signedWorks = false;
                const direct = await pollFitVideoTask(keyConfig(apiKey), { id: "task_s", task_id: "task_s" }, undefined, save);
                assert.equal(direct.status, "completed");
                assert.equal(direct.video_url, signed);
                assert.equal(direct.storageKey, undefined);
                assert.equal(saved.length, 1);
            },
        );
    } finally {
        if (!hadWindow) delete globals.window;
    }
});

test("三把令牌时：上传参考素材和提交只用视频令牌，任务记下 fitKeyRef（令牌 id，不是密钥）；没选视频令牌时不发请求", async () => {
    await withFit(
        {
            "POST https://openai.fit/v1/uploads": (call) => Response.json({ url: `https://openai.fit/uploads/${((call.body as FormData).get("file") as File).name}`, expires_at: Math.floor(clock / 1000) + 72 * 3600 }),
            "POST https://openai.fit/v1/videos": () => Response.json({ id: "task_three", status: "queued" }),
        },
        async ({ calls, apiKey }) => {
            const fitKeys = { video: slot(21, apiKey), image: slot(22, `${apiKey}-image`), text: slot(23, `${apiKey}-text`) };
            const settings = { ...config(apiKey, "wan3.0-video", { videoSeconds: "6", vquality: "480p", size: "16:9" }), fitKeys };
            const created = await createFitVideoTask(settings, "镜头缓慢推进", { firstFrame: image("first") });
            assert.equal(created.task.fitKeyRef, "t:21");
            assert.doesNotMatch(JSON.stringify(created.task), new RegExp(apiKey));
            assert.ok(calls.length >= 2);
            assert.ok(calls.every((call) => call.authorization === `Bearer ${apiKey}`));
            const before = calls.length;
            const { video: _video, ...others } = fitKeys;
            await assert.rejects(createFitVideoTask({ ...settings, fitKeys: others }, "镜头缓慢推进", {}), { message: "缺少可用的视频令牌，请在设置中查看模型服务状态" });
            assert.equal(calls.length, before);
            // 手动令牌优先：ref 记 manual
            const manual = await createFitVideoTask({ ...config(apiKey, "seedance2.0 SEA", { videoSeconds: "8", vquality: "720", size: "1280x720" }), fitKeys, fitManualKey: "sk-manual-video-0123456789" }, "镜头缓慢推进", {});
            assert.equal(manual.task.fitKeyRef, "manual");
            assert.equal(calls.at(-1)?.authorization, "Bearer sk-manual-video-0123456789");
        },
    );
});

test("轮询和下载按任务的 fitKeyRef 用提交时那把令牌，不是现在的视频槽位；找不到时用手动令牌，再不行用视频令牌", async () => {
    await withFit(
        {
            "GET https://openai.fit/v1/videos/task_ref": () => Response.json({ id: "task_ref", status: "completed", progress: 100 }),
            "GET https://openai.fit/v1/videos/task_ref/content": () => videoResponse(),
        },
        async ({ calls, apiKey }) => {
            const save = async () => ({ url: "blob:ref", storageKey: "generated-video:ref" });
            // 提交时用的是令牌 31；之后视频槽位换成了令牌 32，令牌 31 还在图片槽位上
            const fitKeys = { video: slot(32, `${apiKey}-now`), image: slot(31, `${apiKey}-then`) };
            await pollFitVideoTask({ fitKeys, fitManualKey: "" }, { id: "task_ref", task_id: "task_ref", fitKeyRef: "t:31" }, undefined, save);
            assert.deepEqual(calls.map((call) => call.authorization), [`Bearer ${apiKey}-then`, `Bearer ${apiKey}-then`]);
            calls.length = 0;
            // 令牌 31 已经不在任何槽位：同一个 fit 账号的任意令牌都能查，退回视频令牌
            await pollFitVideoTask({ fitKeys: { video: slot(32, `${apiKey}-now`) }, fitManualKey: "" }, { id: "task_ref", task_id: "task_ref", fitKeyRef: "t:31" }, undefined, save);
            assert.equal(calls[0].authorization, `Bearer ${apiKey}-now`);
            calls.length = 0;
            // 旧任务没有 ref、或 ref 是 manual：有手动令牌用手动令牌
            await pollFitVideoTask({ fitKeys, fitManualKey: "sk-manual-poll-0123456789" }, { id: "task_ref", task_id: "task_ref", fitKeyRef: "t:99" }, undefined, save);
            assert.equal(calls[0].authorization, "Bearer sk-manual-poll-0123456789");
        },
    );
});
