import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import axios, { AxiosError, AxiosHeaders } from "axios";
import { FIT_CHANNEL_ID } from "@/lib/model-channel";
import { buildModelProfile } from "@/lib/fit-generate/lib/model-profiles";
import { validateSubmission } from "@/lib/fit-generate/lib/validate-submission";
import { classifyFitModels, type FitCatalog } from "@/lib/fit-models";
import { fitAllowsEmptyPrompt } from "@/lib/fit-panel";
import { SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { fetchFitCatalog, fitProfileFor, loadFitStudio } from "@/services/api/fit/catalog";
import { pollFitVideoTask } from "@/services/api/fit/video";
import { canvasToFitValues, fitIssueText } from "@/services/api/fit/values";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { emptyReferenceHint, fitCardsToWait, fitVideoConfig, legacyAudioReferences, legacyVideoReferenceError, pickReferences, referenceCountNotice, submitOnce, videoPollFailure, videoTaskSize, workbenchReferenceLimits } from "./fit-workbench";

const keysOf = (key: string) => ({ video: key, image: key, text: key });

/** 用 fit 视频轮询的真实报错：GET /v1/videos/task_x 按桩返回。 */
async function fitPollError(reply: () => Response | Promise<Response>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => reply()) as unknown as typeof fetch;
    try {
        return await pollFitVideoTask({ fitKeys: {}, fitManualKey: "sk-workbench" }, { id: "task_x", task_id: "task_x" }).then(
            () => assert.fail("轮询应该报错"),
            (error: unknown) => error,
        );
    } finally {
        globalThis.fetch = original;
    }
}

/** 照视频工作台的写法连续轮询：每次出错把上一轮的次数传进去，返回每次之后日志的状态。 */
function statuses(errors: unknown[], fit = true) {
    let failures = 0;
    return errors.map((error) => {
        const next = videoPollFailure(error, failures, fit);
        failures = next.failures;
        return next.status;
    });
}

test("openai.fit 轮询断网、502（有没有响应体）、429 时日志仍是「生成中」，连续出错多少次都不判失败", async () => {
    const transient = [
        await fitPollError(() => Promise.reject(new TypeError("Failed to fetch"))),
        await fitPollError(() => Response.json({ error: { message: "bad gateway" } }, { status: 502 })),
        await fitPollError(() => new Response("", { status: 502 })),
        await fitPollError(() => Response.json({ error: { message: "rate limited" } }, { status: 429 })),
    ];
    for (const error of transient) assert.deepEqual(statuses(Array(8).fill(error)), Array(8).fill("生成中"), String(error));
});

test("openai.fit 连续 5 次非临时错误才判失败（夹着临时错误照样累计）；中间查成功过（调用方清零）就重新数", async () => {
    const denied = await fitPollError(() => Response.json({ error: { message: "invalid token" } }, { status: 401 }));
    assert.deepEqual(statuses(Array(5).fill(denied)), ["生成中", "生成中", "生成中", "生成中", "失败"]);
    const network = await fitPollError(() => Promise.reject(new TypeError("Failed to fetch")));
    // 夹在中间的临时错误不计数、也不清零
    assert.deepEqual(statuses([network, network, network, network, denied]), ["生成中", "生成中", "生成中", "生成中", "生成中"]);
    assert.deepEqual(statuses([denied, network, denied, denied, network, denied, denied]), ["生成中", "生成中", "生成中", "生成中", "生成中", "生成中", "失败"]);
    // 中间查成功一次（视频工作台把次数清零）就重新数
    assert.deepEqual(statuses([denied, denied, denied]).concat(statuses([denied, denied])), Array(5).fill("生成中"));
});

test("别的渠道照旧：非临时错误立即失败，axios 的 5xx 和断网仍算临时", () => {
    assert.deepEqual(statuses([new Error("任务不存在")], false), ["失败"]);
    const unavailable = new AxiosError("unavailable", "ERR_BAD_RESPONSE", undefined, undefined, { status: 503, statusText: "", headers: {}, config: { headers: new AxiosHeaders() }, data: null });
    assert.deepEqual(statuses([unavailable, new AxiosError("Network Error", "ERR_NETWORK")], false), ["生成中", "生成中"]);
});

test("fit 配置提交时画幅原样交给 canvasToFitValues：wan3.0-video 的 4:3、1:1 不再被改成 1280x720，720P 没有自适应", async () => {
    const wan = buildModelProfile({ model_name: "wan3.0-video", supported_endpoint_types: ["openai-video"] });
    assert.ok(wan);
    const fit = { activeChannelId: FIT_CHANNEL_ID, fitKeys: {}, fitManualKey: "sk-workbench", vquality: "720P", videoSeconds: "6" } as AiConfig;
    for (const size of ["4:3", "1:1"]) {
        const config = fitVideoConfig({ ...fit, size }, "wan3.0-video");
        assert.ok(config);
        assert.equal(config.model, "wan3.0-video");
        assert.equal(config.videoModel, "wan3.0-video");
        const values = await canvasToFitValues(wan, config, "女孩回头");
        assert.deepEqual({ aspectRatio: values.aspectRatio, resolution: values.resolution }, { aspectRatio: size, resolution: "720P" });
    }
    const adaptive720 = await canvasToFitValues(wan, fitVideoConfig({ ...fit, size: "adaptive" }, "wan3.0-video")!, "女孩回头");
    assert.notEqual(adaptive720.aspectRatio, "adaptive");
    const adaptive480 = await canvasToFitValues(wan, fitVideoConfig({ ...fit, size: "adaptive", vquality: "480P" }, "wan3.0-video")!, "女孩回头");
    assert.equal(adaptive480.aspectRatio, "adaptive");
    assert.equal(fitVideoConfig({ ...fit, activeChannelId: "other", localChannels: [], baseUrl: "https://example.com" } as AiConfig, "wan3.0-video"), null);
});

test("openai.fit 出片后视频工作台记下成片的实际宽高（mediaSize），不按任务里的画幅（adaptive、16:9）退成 1280x720", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
        String(input).endsWith("/content") ? new Response(new Uint8Array([0, 0, 0, 24]), { headers: { "content-type": "video/mp4" } }) : Response.json({ id: "task_size", status: "completed", progress: 100 })) as unknown as typeof fetch;
    try {
        const save = async () => ({ url: "blob:local-video", storageKey: "generated-video:size", width: 720, height: 1280 });
        for (const size of ["adaptive", "16:9"]) {
            const done = await pollFitVideoTask({ fitKeys: {}, fitManualKey: "sk-workbench" }, { id: "task_size", task_id: "task_size", status: "processing", size }, undefined, save);
            assert.equal(done.size, size);
            assert.deepEqual(videoTaskSize(done), { width: 720, height: 1280 });
        }
    } finally {
        globalThis.fetch = original;
    }
    // 别的渠道照旧读 size 的 WxH，读不到按 1280x720
    assert.deepEqual(videoTaskSize({ size: "1920x1080" }), { width: 1920, height: 1080 });
    assert.deepEqual(videoTaskSize({ size: "16:9" }), { width: 1280, height: 720 });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const GATE_MODEL = "wan3.0-video";
let gateClock = Date.now() + 365 * 24 * 3600_000;
let gateKeys = 0;

/**
 * 接管 /v1/models（按令牌返回：-empty 结尾的一个模型都没有，-bad 结尾的回 401，其余返回 wan3.0-video，可以设延迟）；/api/fit/catalog 一律失败，
 * 不留目录缓存、按打包规则出卡片。时钟拨到一年后，别的测试文件留下的缓存都过期。开始前先用没有视频模型的令牌读一次：fitProfileFor 查不到这张卡，相当于第一次打开工作台。
 */
async function withFitCards(run: (ctx: { apiKey: string; modelCalls: string[]; slow: (ms: number) => void; expire: () => void }) => Promise<void>) {
    const original = { fetch: globalThis.fetch, adapter: axios.defaults.adapter, now: Date.now };
    gateClock += 120_000;
    Date.now = () => gateClock;
    let delayMs = 0;
    const modelCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        assert.equal(String(input), "https://openai.fit/v1/models");
        const authorization = new Headers(init?.headers).get("Authorization") || "";
        modelCalls.push(authorization);
        if (delayMs) await sleep(delayMs);
        if (authorization.endsWith("-bad")) return Response.json({ error: { message: "invalid token" } }, { status: 401 });
        return Response.json({ success: true, data: authorization.endsWith("-empty") ? [] : [{ id: GATE_MODEL, supported_endpoint_types: ["openai-video"] }] });
    }) as typeof fetch;
    axios.defaults.adapter = async () => Promise.reject(new Error("offline"));
    try {
        await loadFitStudio(keysOf(`sk-gate-${++gateKeys}-empty`));
        assert.equal(fitProfileFor(GATE_MODEL), null);
        modelCalls.length = 0;
        await run({ apiKey: `sk-gate-${++gateKeys}`, modelCalls, slow: (ms) => (delayMs = ms), expire: () => (gateClock += 120_000) });
    } finally {
        // 清掉这里留下的「未来时间」令牌缓存（失败的请求不缓存）
        gateClock += 120_000;
        globalThis.fetch = (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
        await loadFitStudio(keysOf("sk-gate-cleanup")).catch(() => undefined);
        await fetchFitCatalog().catch(() => undefined);
        globalThis.fetch = original.fetch;
        axios.defaults.adapter = original.adapter;
        Date.now = original.now;
    }
}

const fitConfig = (apiKey: string) => ({ activeChannelId: FIT_CHANNEL_ID, fitKeys: {}, fitManualKey: apiKey, vquality: "720P", videoSeconds: "6", size: "16:9" }) as AiConfig;
const otherChannel = { activeChannelId: "other", localChannels: [], baseUrl: "https://example.com" } as unknown as AiConfig;

/**
 * 照 video/page.tsx 的 generate：点「生成」用的是点击当下那次渲染的提示词（React 每次渲染给按钮新的闭包），提示词空了按钮变灰、回车也不触发；
 * 拼好请求就清空提示词，再提交（submitted 记下提交了几次）。
 */
function workbench(apiKey: string) {
    const locks = new Set<string>();
    const state = { prompt: "女孩回头", submitted: [] as string[] };
    const generate = async () => {
        const prompt = state.prompt;
        if (!prompt.trim()) return;
        const snapshot = await submitOnce(locks, "generate", fitCardsToWait(fitConfig(apiKey), GATE_MODEL), () => {
            state.prompt = "";
            return prompt;
        });
        if (snapshot) state.submitted.push(snapshot);
    };
    return { locks, state, generate };
}

test("视频工作台：这张卡还没读到时先等目录，等的时候再点一次（双击、连按回车）被忽略，只提交一次、只读一次目录", async () => {
    await withFitCards(async ({ apiKey, modelCalls, slow }) => {
        slow(300);
        const page = workbench(apiKey);
        const first = page.generate();
        // 还在等卡片：提示词没清空，按钮仍可点
        assert.equal(page.state.prompt, "女孩回头");
        await sleep(100);
        const second = page.generate();
        await Promise.all([first, second]);
        assert.deepEqual(page.state.submitted, ["女孩回头"]);
        assert.equal(modelCalls.length, 1);
        assert.ok(fitProfileFor(GATE_MODEL));
        assert.equal(page.locks.size, 0);
    });
});

test("视频工作台：卡片读到过、60 秒缓存过期后不再等目录，点击当下就清空提示词，连点两次只提交一次，也不重新请求", async () => {
    await withFitCards(async ({ apiKey, modelCalls, slow, expire }) => {
        await loadFitStudio(keysOf(apiKey));
        expire();
        slow(300);
        modelCalls.length = 0;
        const page = workbench(apiKey);
        const first = page.generate();
        assert.equal(page.state.prompt, "");
        await sleep(100);
        const second = page.generate();
        await Promise.all([first, second]);
        assert.deepEqual(page.state.submitted, ["女孩回头"]);
        assert.deepEqual(modelCalls, []);
        // 对照：缓存确实过期了，这时再读会重新请求
        await loadFitStudio(keysOf(apiKey));
        assert.equal(modelCalls.length, 1);
    });
});

test("视频工作台重试：等卡片时、提交还没走完时再点都被忽略，双击只重试一次；提交走完后同一条还能再重试", async () => {
    await withFitCards(async ({ apiKey, slow }) => {
        slow(300);
        const locks = new Set<string>();
        const submitted: string[] = [];
        const cards = new Set(["result_1", "log_1"]);
        // 照 retryResult / retryGenerationLog：按卡片或记录 id 上锁，锁到提交（上传素材、POST /v1/videos）走完
        const retry = (id: string, removeCard: boolean) =>
            submitOnce(locks, `retry:${id}`, fitCardsToWait(fitConfig(apiKey), GATE_MODEL), async () => {
                if (removeCard) cards.delete(id);
                submitted.push(id);
                await sleep(150);
            });
        // 结果卡上的「重试」：卡片还没读到，点完 100ms 再点一次（这时卡片还在）
        const first = retry("result_1", true);
        await sleep(100);
        assert.ok(cards.has("result_1"));
        await Promise.all([first, retry("result_1", true)]);
        assert.deepEqual(submitted, ["result_1"]);
        // 历史记录上的「重试」：卡片已读到，同步开始提交；记录还在，提交走完前再点被忽略
        const again = retry("log_1", false);
        await sleep(50);
        await Promise.all([again, retry("log_1", false)]);
        assert.deepEqual(submitted, ["result_1", "log_1"]);
        await retry("log_1", false);
        assert.deepEqual(submitted, ["result_1", "log_1", "log_1"]);
        assert.equal(locks.size, 0);
    });
});

test("提交锁在第一次失败后释放：拼请求报错、校验没过（返回空）、提交失败、卡片读不到（令牌无效）后，下一次照常提交", async () => {
    const locks = new Set<string>();
    await assert.rejects(
        submitOnce(locks, "generate", undefined, () => {
            throw new Error("请输入视频提示词");
        }),
        /请输入视频提示词/,
    );
    assert.equal(locks.size, 0);
    assert.equal(await submitOnce(locks, "generate", undefined, () => null), null);
    assert.equal(await submitOnce(locks, "generate", undefined, () => "ok"), "ok");
    await assert.rejects(
        submitOnce(locks, "retry:r1", Promise.resolve(), async () => {
            throw new Error("视频任务创建失败");
        }),
        /视频任务创建失败/,
    );
    assert.equal(await submitOnce(locks, "retry:r1", undefined, () => "ok"), "ok");
    assert.equal(locks.size, 0);
    // 令牌无效：等卡片时 /v1/models 回 401，错误吞掉照常往下走（由 createFitVideoTask 报原因），锁也释放
    await withFitCards(async ({ apiKey, modelCalls }) => {
        const bad = `${apiKey}-bad`;
        assert.equal(await submitOnce(locks, "generate", fitCardsToWait(fitConfig(bad), GATE_MODEL), () => "submitted"), "submitted");
        assert.deepEqual(modelCalls, [`Bearer ${bad}`]);
        assert.equal(locks.size, 0);
    });
    // 不是 fit 配置不等目录
    assert.equal(fitCardsToWait(otherChannel, GATE_MODEL), undefined);
});

/** 2026-11-01 openai.fit /api/model-capabilities 里的两张 GT 卡（原样）。 */
const GT_CARDS = [
    { available: true, defaultDuration: 15, defaultRatio: "9:16", defaultReferenceMode: "mixed", defaultResolution: "720P", description: "视频生成模型：时长 15、30 秒；清晰度 720P、1080P；画幅 16:9、9:16、1:1、4:3、3:4、21:9；可上传最多 10 张参考图、5 段参考视频、5 段参考音频。", durations: [15, 30], family: "url-lists", id: "wan3.0-video-prime-GT", kind: "video", maxAudios: 5, maxImages: 10, maxVideos: 5, mediaLimits: {}, name: "wan3.0-video-prime-GT", parameterSchema: [], promptMaxLength: 12000, ratios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], referenceModes: [{ id: "text", label: "纯文字生成", maxAudios: 0, maxImages: 0, maxTotal: 0, maxVideos: 0 }, { id: "multi", label: "参考图片", maxAudios: 0, maxImages: 10, maxTotal: 10, maxVideos: 0 }, { id: "mixed", label: "参考素材", maxAudios: 5, maxImages: 10, maxTotal: 20, maxVideos: 5 }], resolutions: ["720P", "1080P"], visible: true },
    { available: true, defaultDuration: 5, defaultRatio: "16:9", defaultReferenceMode: "text", defaultResolution: "480p", description: "4–30秒整数，默认5秒；480p、720p、1080p；支持7种画幅、声音开关及普通图片/视频/音频参考。最多30张图、10段视频、10段音频，总50项；参考视频每段2–15秒、合计不超过15秒，参考音频每段2–30秒、合计不超过30秒；纯音频及无提示词素材任务可用。", durations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30], family: "openai-video", id: "seedance 2.5-GT", kind: "video", maxAudios: 10, maxImages: 30, maxVideos: 10, mediaLimits: { audioMaxSeconds: 30, audioMinSeconds: 2, audioTotalMaxSeconds: 30, videoMaxSeconds: 15, videoMinSeconds: 2, videoTotalMaxSeconds: 15 }, name: "Seedance 2.5-GT", parameterSchema: [{ default: true, key: "generate_audio", label: "Generate audio", type: "boolean" }, { default: false, key: "watermark", label: "Watermark", type: "boolean" }, { default: false, key: "return_last_frame", label: "Return last frame", type: "boolean" }, { default: "mp4", key: "output_format", label: "Output format", options: ["mp4", "mov"], type: "select" }], ratios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"], referenceModes: [{ id: "text", label: "纯文字生成", maxAudios: 0, maxImages: 0, maxTotal: 0, maxVideos: 0, minImages: 0 }, { id: "multi", label: "普通参考图片", maxAudios: 0, maxImages: 30, maxTotal: 30, maxVideos: 0, minImages: 0 }, { id: "mixed", label: "图片、视频或音频参考（可混用）", maxAudios: 10, maxImages: 30, maxTotal: 50, maxVideos: 10, minImages: 0 }], resolutions: ["480p", "720p", "1080p"], visible: true },
];

test("openai.fit 配置下提交前不跑旧渠道的参考视频限制（合计 ≤15 秒等）：GT 卡两段 12 秒参考视频不被这一步拦，由 validateSubmission 按卡片查", async () => {
    const clips: ReferenceVideo[] = ["a", "b"].map((id) => ({ id, name: `${id}.mp4`, type: "video/mp4", url: "data:video/mp4;base64,AAAAIGZ0eXA=", durationMs: 12_000, width: 1280, height: 720 }));
    // 别的渠道照旧拦
    assert.equal(legacyVideoReferenceError(otherChannel, clips, SEEDANCE_REFERENCE_LIMITS), "Seedance 参考视频总时长不能超过 15 秒");
    const catalog = {
        pricing: GT_CARDS.map((card) => ({ model_name: card.id, supported_endpoint_types: ["openai-video"], tags: "视频生成" })),
        capabilities: { schemaVersion: 1, revision: "r-20261101", models: GT_CARDS },
        fetchedAt: 1_793_500_000,
        stale: false,
    } as unknown as FitCatalog;
    const { profiles } = classifyFitModels(
        GT_CARDS.map((card) => ({ id: card.id, supported_endpoint_types: ["openai-video"] })),
        catalog,
    );
    for (const card of GT_CARDS) {
        const config = { ...fitConfig("sk-workbench"), vquality: card.defaultResolution, videoSeconds: "15", size: "9:16" } as AiConfig;
        assert.equal(legacyVideoReferenceError(config, clips, SEEDANCE_REFERENCE_LIMITS), "", card.id);
        const profile = profiles[card.id];
        assert.ok(profile, card.id);
        const issues = validateSubmission(profile, await canvasToFitValues(profile, config, "女孩回头", { videoReferences: clips }));
        // wan3.0-video-prime-GT 不限片长，两段合计 24 秒照常提交；seedance 2.5-GT 卡片自己规定参考视频合计不超过 15 秒，由卡片规则报
        if (card.id === "wan3.0-video-prime-GT") assert.deepEqual(issues, []);
        else assert.match(fitIssueText(issues), /15/);
    }
});

test("openai.fit 配置下添加参考音频不按旧渠道时长筛（单个、合计 ≤15 秒）：file-storage 现在读得出音频片长，seedance 2.5-GT 合计 30 秒内的音频留给卡片校验", async () => {
    const clips: ReferenceAudio[] = ["a", "b"].map((id) => ({ id, name: `${id}.mp3`, type: "audio/mpeg", url: "data:audio/mpeg;base64,SUQz", durationMs: 12_000 }));
    const warnings: string[] = [];
    const warn = (text: string) => void warnings.push(text);
    // 别的渠道照旧：第二段让合计超过 15 秒，忽略并提示
    assert.deepEqual(legacyAudioReferences(otherChannel, [clips[0]], [clips[1]], SEEDANCE_REFERENCE_LIMITS, warn), []);
    assert.deepEqual(warnings, ["已忽略不符合时长要求的参考音频：单个 2-15 秒，总时长不超过 15 秒"]);
    warnings.length = 0;
    const config = { ...fitConfig("sk-workbench"), vquality: "480p", videoSeconds: "5", size: "16:9" } as AiConfig;
    assert.deepEqual(legacyAudioReferences(config, [clips[0]], [clips[1]], SEEDANCE_REFERENCE_LIMITS, warn), [clips[1]]);
    assert.deepEqual(warnings, []);
    const card = GT_CARDS.find((item) => item.id === "seedance 2.5-GT")!;
    const catalog = {
        pricing: [{ model_name: card.id, supported_endpoint_types: ["openai-video"], tags: "视频生成" }],
        capabilities: { schemaVersion: 1, revision: "r-20261101", models: [card] },
        fetchedAt: 1_793_500_000,
        stale: false,
    } as unknown as FitCatalog;
    const profile = classifyFitModels([{ id: card.id, supported_endpoint_types: ["openai-video"] }], catalog).profiles[card.id];
    assert.ok(profile);
    // 两段 12 秒合计 24 秒，卡片放行；单段 31 秒由卡片规则拦
    assert.deepEqual(validateSubmission(profile, await canvasToFitValues(profile, config, "女孩回头", { audioReferences: clips })), []);
    const long = [{ ...clips[0], durationMs: 31_000 }];
    assert.match(fitIssueText(validateSubmission(profile, await canvasToFitValues(profile, config, "女孩回头", { audioReferences: long }))), /30/);
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    assert.equal(source.match(/legacyAudioReferences\(videoConfig, audioReferences, /g)?.length, 3);
    assert.doesNotMatch(source, /filterAudioReferencesByDuration/);
});

test("视频工作台接线：生成和两种重试都走 submitOnce + fitCardsToWait，不再先 await loadFitStudio；buildRequestSnapshot 用 legacyVideoReferenceError", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    assert.match(source, /submitOnce\(submitLocksRef\.current, "generate", fitCardsToWait\(videoConfig, model\), \(\) => \{/);
    assert.match(source, /submitOnce\(submitLocksRef\.current, `retry:\$\{result\.id\}`, fitCardsToWait\(configValue, result\.model\)/);
    assert.match(source, /submitOnce\(submitLocksRef\.current, `retry:\$\{log\.id\}`, fitCardsToWait\(configValue, log\.model\)/);
    assert.match(source, /const videoReferenceError = legacyVideoReferenceError\(configValue, videoReferenceItems, limits\);/);
    assert.doesNotMatch(source, /loadFitStudio|seedanceVideoReferenceError\(/);
});

test("视频工作台接线：openai.fit 的视频从提交起不给停止（停了照样扣费、结果丢），删生成中的记录时提示照常扣费", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    assert.match(source, /const showStop = stopped \|\| stopping \|\| Boolean\(result\.providerWorkflowRef\) \|\| !isFitConfig\(result\.config\);/);
    assert.match(source, /\{showStop \? <Button type=\{stopped \? "default" : "primary"\}/);
    assert.match(source, /log\.status === "生成中" && !log\.providerWorkflowRef && isFitConfig\(log\.config\)\) \? <div className="mt-2 text-xs opacity-70">其中有还在 openai\.fit 上生成的视频/);
});

/** GT_CARDS 照画布读目录的方式（classifyFitModels，内部是 fit 生成台的 buildStudioModels）建出的 profile。 */
function gtProfile(id: string) {
    const catalog = {
        pricing: GT_CARDS.map((card) => ({ model_name: card.id, supported_endpoint_types: ["openai-video"], tags: "视频生成" })),
        capabilities: { schemaVersion: 1, revision: "r-20261101", models: GT_CARDS },
        fetchedAt: 1_793_500_000,
        stale: false,
    } as unknown as FitCatalog;
    const profile = classifyFitModels(
        GT_CARDS.map((card) => ({ id: card.id, supported_endpoint_types: ["openai-video"] })),
        catalog,
    ).profiles[id];
    assert.ok(profile, id);
    return profile;
}

const MB = 1024 * 1024;

test("视频工作台添加参考素材：openai.fit 按卡片的个数截（seedance 2.5-GT 30 张图、10 段视频、10 段音频，wan3.0-video-prime-GT 5 段视频），大小照 fit 生成台（图 40MB、音视频 100MB）；卡片没读到时不截；别的渠道照旧", async () => {
    const legacy = { ...SEEDANCE_REFERENCE_LIMITS };
    const fit = fitConfig("sk-workbench");
    const gt = workbenchReferenceLimits(fit, gtProfile("seedance 2.5-GT"), legacy);
    const wan = workbenchReferenceLimits(fit, gtProfile("wan3.0-video-prime-GT"), legacy);
    const unknown = workbenchReferenceLimits(fit, null, legacy);
    assert.deepEqual(gt, { images: 30, videos: 10, audios: 10, imageMaxBytes: 40 * MB, videoMaxBytes: 100 * MB, audioMaxBytes: 100 * MB });
    assert.deepEqual(wan, { images: 10, videos: 5, audios: 5, imageMaxBytes: 40 * MB, videoMaxBytes: 100 * MB, audioMaxBytes: 100 * MB });
    assert.deepEqual([unknown.images, unknown.videos, unknown.audios], [Infinity, Infinity, Infinity]);
    assert.equal(workbenchReferenceLimits(otherChannel, gtProfile("seedance 2.5-GT"), legacy), legacy);
    assert.equal(workbenchReferenceLimits({ ...fit, videoWorkflowRef: { id: "wf" } } as unknown as AiConfig, gtProfile("seedance 2.5-GT"), legacy), legacy);

    // 照 addReferences：wan3.0-video-prime-GT 一次加 6 段 60MB 的视频，收 5 段、提示多出的；旧规则（3 段、50MB）一段都不收
    const clips = Array.from({ length: 6 }, (_, index) => ({ name: `clip-${index}.mp4`, size: 60 * MB }));
    assert.deepEqual(pickReferences(clips, 0, wan.videos, wan.videoMaxBytes, "参考视频", "个"), { picked: clips.slice(0, 5), notices: ["参考视频最多 5 个，多出的已忽略"] });
    assert.deepEqual(pickReferences(clips, 0, legacy.videos, legacy.videoMaxBytes, "参考视频", "个"), { picked: [], notices: ["已忽略超过 50MB 的参考视频"] });
    // seedance 2.5-GT：已有 9 张图再加 25 张 35MB 的（旧规则 30MB、10 张），收到 30 张为止
    const images = Array.from({ length: 25 }, (_, index) => ({ name: `image-${index}.png`, size: 35 * MB }));
    assert.deepEqual(pickReferences(images, 9, gt.images, gt.imageMaxBytes, "参考图", "张"), { picked: images.slice(0, 21), notices: ["参考图最多 30 张，多出的已忽略"] });
    assert.deepEqual(pickReferences([...images.slice(0, 2), { name: "huge.png", size: 41 * MB }], 0, gt.images, gt.imageMaxBytes, "参考图", "张"), { picked: images.slice(0, 2), notices: ["已忽略超过 40MB 的参考图"] });
    // 卡片还没读到：不截个数；卡片不收这种素材（个数是 0）时直说
    assert.equal(pickReferences(Array(12).fill({ size: MB }), 0, unknown.audios, unknown.audioMaxBytes, "参考音频", "个").picked.length, 12);
    assert.deepEqual(pickReferences([{ size: MB }], 0, 0, Infinity, "参考视频", "个"), { picked: [], notices: ["当前模型不收参考视频"] });
    assert.equal(referenceCountNotice("参考音频", 10, "个"), "参考音频最多 10 个，多出的已忽略");
    // 素材栏空着时的提示跟着上限走
    assert.equal(emptyReferenceHint("参考视频", wan.videos, "个"), "暂无参考视频，最多 5 个");
    assert.equal(emptyReferenceHint("参考图", unknown.images, "张"), "暂无参考图");
    assert.equal(emptyReferenceHint("参考音频", 0, "个", "，mp3/wav，单个 100MB 内"), "当前模型不收参考音频");
    assert.equal(emptyReferenceHint("参考音频", gt.audios, "个", `，mp3/wav，单个 ${gt.audioMaxBytes / MB}MB 内`), "暂无参考音频，最多 10 个，mp3/wav，单个 100MB 内");

    // 收下的个数和提交时 validateSubmission 按卡片查的一致：wan3.0-video-prime-GT 5 段放行，第 6 段才拦
    const wanProfile = gtProfile("wan3.0-video-prime-GT");
    const config = { ...fit, vquality: "720P", videoSeconds: "15", size: "9:16" } as AiConfig;
    const videos: ReferenceVideo[] = clips.map((clip, index) => ({ id: `v${index}`, name: clip.name, type: "video/mp4", url: "data:video/mp4;base64,AAAAIGZ0eXA=", durationMs: 5_000 }));
    assert.deepEqual(validateSubmission(wanProfile, await canvasToFitValues(wanProfile, config, "女孩回头", { videoReferences: videos.slice(0, 5) })), []);
    assert.equal(fitIssueText(validateSubmission(wanProfile, await canvasToFitValues(wanProfile, config, "女孩回头", { videoReferences: videos }))), "视频参考最多 5 个");
});

test("视频工作台接线：添加素材的个数和大小走 workbenchReferenceLimits + pickReferences，素材栏的上限也按卡片；图片工作台添加参考图本来就不截个数和大小", () => {
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    assert.match(source, /const fitProfile = useFitProfile\(!videoConfig\.videoWorkflowRef && isFitConfig\(videoConfig\) \? model : undefined\);/);
    assert.match(source, /const referenceAddLimits = workbenchReferenceLimits\(videoConfig, fitProfile, \{ \.\.\.referenceLimits, images: /);
    assert.match(source, /const referenceImageLimit = referenceAddLimits\.images;\r?\n\s+const videoReferenceLimit = referenceAddLimits\.videos;/);
    assert.match(source, /const stripLimits = workbenchReferenceLimits\(config, fit\.profile, referenceLimits\);/);
    // 上传（三种）、剪贴板（图、视频、音频）都按上限挑并提示
    assert.equal(source.match(/pickReferences\(/g)?.length, 6);
    // 剪贴板参考图只在 openai.fit 下按大小筛；别的配置（含工作流）照 8c92915 不查大小，只截个数
    assert.match(source, /pickReferences\(blobs, references\.length, referenceImageLimit, !videoConfig\.videoWorkflowRef && isFitConfig\(videoConfig\) \? referenceAddLimits\.imageMaxBytes : Infinity, "参考图", "张"\)/);
    // 上传的参考图照旧按 imageMaxBytes（别的配置是旧 seedance 的 30MB，8c92915 就这样）
    assert.match(source, /\), references\.length, referenceImageLimit, referenceAddLimits\.imageMaxBytes, "参考图", "张"\);/);
    for (const kind of ["images", "videos", "audios"]) assert.match(source, new RegExp(`maxCount=\\{stripLimits\\.${kind}\\}`));
    // 旧 seedance 的个数和大小只剩 Kling 角色元素（3 处）和素材栏的默认值在用
    assert.doesNotMatch(source, /referenceLimits\.audios - |slice\(0, referenceLimits\.audios\)|referenceLimits\.videoMaxBytes|超过 30MB|超过 15MB|单个 15MB 内/);
    assert.equal(source.match(/SEEDANCE_REFERENCE_LIMITS\.(imageMaxBytes|videoMaxBytes|audioMaxBytes)\) return null;/g)?.length, 3);
    const image = readFileSync(new URL("../image/page.tsx", import.meta.url), "utf8");
    assert.doesNotMatch(image, /REFERENCE_LIMITS|MaxBytes|maxReferenceImages/);
});

test("视频工作台只给素材、不写提示词：照 fit 生成台（allowsReferenceOnlySubmission），seedance 2.5-GT 有它收的参考素材就能提交；别的卡、没有素材、卡片没读到、别的渠道仍要提示词", async () => {
    const gt = gtProfile("seedance 2.5-GT");
    const wan = gtProfile("wan3.0-video-prime-GT");
    const config = { ...fitConfig("sk-workbench"), vquality: "720p", videoSeconds: "5", size: "16:9" } as AiConfig;
    const image = { id: "img", name: "a.png", type: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const audio: ReferenceAudio = { id: "aud", name: "a.mp3", type: "audio/mpeg", url: "data:audio/mpeg;base64,SUQz", durationMs: 5_000 };
    assert.equal(fitAllowsEmptyPrompt(config, gt, { references: [image] }), true);
    assert.equal(fitAllowsEmptyPrompt(config, gt, { audioReferences: [audio] }), true);
    assert.equal(fitAllowsEmptyPrompt(config, gt, {}), false);
    // 2.5-GT 没有首帧位，首帧不算它收下的素材
    assert.equal(fitAllowsEmptyPrompt(config, gt, { firstFrame: image }), false);
    assert.equal(fitAllowsEmptyPrompt(config, wan, { references: [image] }), false);
    assert.equal(fitAllowsEmptyPrompt(config, null, { references: [image] }), false);
    assert.equal(fitAllowsEmptyPrompt(otherChannel, gt, { references: [image] }), false);
    // 和提交时 createFitVideoTask 跑的 validateSubmission 一致：空提示词加参考图，2.5-GT 没有问题，wan3.0-video-prime-GT 要提示词
    assert.deepEqual(validateSubmission(gt, await canvasToFitValues(gt, config, "", { references: [image] })), []);
    const wanConfig = { ...config, vquality: "720P", videoSeconds: "15", size: "9:16" } as AiConfig;
    assert.equal(fitIssueText(validateSubmission(wan, await canvasToFitValues(wan, wanConfig, "", { references: [image] }))), "请填写提示词");
    // 接线：生成按钮（canGenerate 用卡片的 hook）和 buildRequestSnapshot（提交前已等过卡片，读 fitProfileFor）；规则和画布节点共用 lib/fit-panel 那一份
    const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
    assert.match(source, /import \{ fitAllowsEmptyPrompt, type FitPanelKey \} from "@\/lib\/fit-panel";/);
    assert.doesNotMatch(readFileSync(new URL("./fit-workbench.ts", import.meta.url), "utf8"), /fitAllowsEmptyPrompt|allowsReferenceOnlySubmission/);
    assert.match(source, /\|\| fitAllowsEmptyPrompt\(videoConfig, fitProfile, \{ references, firstFrame, lastFrame, videoReferences, audioReferences \}\);/);
    assert.match(
        source,
        /if \(!text && !isAutoDLConfig\(configValue, modelValue\) && !fitAllowsEmptyPrompt\(configValue, fitProfileFor\(modelValue\), \{ references: referenceItems, firstFrame: firstFrameItem, lastFrame: lastFrameItem, videoReferences: videoReferenceItems, audioReferences: audioReferenceItems \}\)\) \{/,
    );
});

test("图片工作台：openai.fit 配置下侧边和底部都不显示「接口模式」（images/responses/chat 对 fit 不起作用）", () => {
    const source = readFileSync(new URL("../image/page.tsx", import.meta.url), "utf8");
    const modes = [...source.matchAll(/value=\{config\.apiMode\}/g)];
    assert.equal(modes.length, 2);
    for (const mode of modes) {
        const before = source.slice(0, mode.index);
        const guard = before.lastIndexOf("{!isFitConfig(config) ? (");
        assert.ok(guard >= 0 && guard < before.lastIndexOf("接口模式") && !before.slice(guard).includes(") : null}"), "接口模式要包在 {!isFitConfig(config) ? (...) : null} 里");
    }
});
