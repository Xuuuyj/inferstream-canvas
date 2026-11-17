import assert from "node:assert/strict";
import test from "node:test";
import { getVideoTask } from "@/lib/fit-generate/lib/relay-client";
import { MAX_POLL_FAILURES, VIDEO_POLL_INTERVAL_MS } from "@/lib/fit-generate/constants";
import { videoPollFailure } from "@/app/(user)/video/fit-workbench";
import { fitPollFailure } from "@/lib/fit-panel";
import { FitRequestError, pollFitVideoTask, waitFitVideo } from "../video";

const API_KEY = "sk-video-errors";
const KEYS = { fitKeys: {}, fitManualKey: API_KEY };

/** 接管全局 fetch（fitFetch 最终调它），按「方法 地址」找桩。 */
async function withFetch(routes: Record<string, () => Response | Promise<Response>>, run: () => Promise<void>) {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const route = routes[`${init?.method || "GET"} ${String(input)}`];
        if (!route) throw new Error(`unexpected request ${String(input)}`);
        return route();
    }) as typeof fetch;
    try {
        await run();
    } finally {
        globalThis.fetch = original;
    }
}

async function pollError(id: string, routes: Record<string, () => Response | Promise<Response>>) {
    let caught: unknown;
    await withFetch(routes, async () => {
        caught = await pollFitVideoTask(KEYS, { id, task_id: id }).then(
            () => assert.fail("轮询应该报错"),
            (error: unknown) => error,
        );
    });
    assert.ok(caught instanceof FitRequestError, String(caught));
    return caught;
}

test("轮询时断网、408、429、5xx（有没有响应体都算）抛带状态的临时错误，轮询方据此接着查", async () => {
    const network = await pollError("task_net", { "GET https://openai.fit/v1/videos/task_net": () => Promise.reject(new TypeError("Failed to fetch")) });
    assert.equal(network.message, "连接原模型服务失败，请检查网络后重试");
    assert.equal(network.status, undefined);
    assert.equal(network.retryable, true);

    const cases: Array<[number, string, string]> = [
        [502, JSON.stringify({ error: { message: "bad gateway" } }), "bad gateway"],
        [502, "", "HTTP 502"],
        [503, "<html>Service Unavailable</html>", "HTTP 503"],
        [429, JSON.stringify({ error: { message: "rate limited" } }), "rate limited"],
        [408, "", "HTTP 408"],
    ];
    for (const [status, body, message] of cases) {
        const error = await pollError("task_t", { "GET https://openai.fit/v1/videos/task_t": () => new Response(body, { status }) });
        assert.deepEqual({ status: error.status, retryable: error.retryable, message: error.message }, { status, retryable: true, message });
    }
});

test("令牌无效、任务不存在这类错误也带状态，但不是临时错误", async () => {
    for (const status of [401, 403, 404]) {
        const error = await pollError("task_p", { "GET https://openai.fit/v1/videos/task_p": () => Response.json({ error: { message: `denied ${status}` } }, { status }) });
        assert.deepEqual({ status: error.status, retryable: error.retryable, message: error.message }, { status, retryable: false, message: `denied ${status}` });
    }
});

test("已完成但 /content 和取签名链接都回 503（没有响应体）时同样是临时错误，下一轮重新下载", async () => {
    const error = await pollError("task_d", {
        "GET https://openai.fit/v1/videos/task_d": () => Response.json({ id: "task_d", status: "completed", progress: 100 }),
        "GET https://openai.fit/v1/videos/task_d/content": () => new Response("", { status: 503 }),
        "GET https://openai.fit/v1/tasks/task_d/artifacts": () => new Response("", { status: 503 }),
    });
    assert.deepEqual({ status: error.status, retryable: error.retryable }, { status: 503, retryable: true });
});

test("状态解析和 fit 生成库的 getVideoTask 一致（未知状态算生成中，进度夹在 0–100）", async () => {
    const payloads = [{ status: "queued", progress: 0 }, { status: "in_progress", progress: 42 }, { status: "RUNNING", progress: 150 }, { status: "failed", progress: "x", error: { message: "生成失败，请联系管理员" } }, {}];
    const statusOf = { queued: "queued", in_progress: "processing", failed: "failed" } as const;
    for (const payload of payloads) {
        await withFetch({ "GET https://openai.fit/v1/videos/task_s": () => Response.json(payload) }, async () => {
            const expected = await getVideoTask("task_s", API_KEY);
            const polled = await pollFitVideoTask(KEYS, { id: "task_s", task_id: "task_s" });
            assert.equal(polled.status, statusOf[expected.status as keyof typeof statusOf], JSON.stringify(payload));
            assert.equal(polled.progress, expected.progress, JSON.stringify(payload));
            assert.equal(polled.error?.message ?? null, expected.status === "failed" ? expected.error : null);
        });
    }
});

/** waitFitVideo 一轮一轮查 GET /v1/videos/task_w，按顺序取桩；等待不真睡（记下每次等的毫秒数）。 */
async function waitWith(replies: Array<() => Response | Promise<Response>>) {
    const original = { fetch: globalThis.fetch, setTimeout: globalThis.setTimeout };
    const sleeps: number[] = [];
    const progress: number[] = [];
    let polls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        assert.equal(String(input), "https://openai.fit/v1/videos/task_w");
        const reply = replies[polls++];
        if (!reply) throw new Error("轮询次数超出预期");
        return reply();
    }) as typeof fetch;
    globalThis.setTimeout = ((resolve: () => void, ms?: number) => {
        sleeps.push(ms ?? 0);
        queueMicrotask(resolve);
        return 0;
    }) as unknown as typeof setTimeout;
    try {
        const error = await waitFitVideo(KEYS, { id: "task_w", task_id: "task_w" }, { onProgress: (value) => progress.push(value) }).then(
            () => assert.fail("这组桩以报错结束"),
            (caught: unknown) => caught,
        );
        return { error, polls, sleeps, progress };
    } finally {
        globalThis.fetch = original.fetch;
        globalThis.setTimeout = original.setTimeout;
    }
}

const network = () => Promise.reject(new TypeError("Failed to fetch"));
const badGateway = () => new Response("", { status: 502 });
const rateLimited = () => Response.json({ error: { message: "rate limited" } }, { status: 429 });
const denied = () => Response.json({ error: { message: "invalid token" } }, { status: 401 });
const missing = () => Response.json({ error: { message: "task not found" } }, { status: 404 });

test("waitFitVideo：断网、502、429 接着等不计数；非临时错误连续 4 次不报错，查成功一次清零；最后按 fit 返回的任务结果结束", async () => {
    const { error, polls, sleeps, progress } = await waitWith([
        network, badGateway, rateLimited, badGateway, network,
        denied, denied, denied, denied,
        () => Response.json({ id: "task_w", status: "in_progress", progress: 50 }),
        missing, badGateway, missing, missing, missing,
        () => Response.json({ id: "task_w", status: "failed", error: { message: "生成失败，请联系管理员" } }),
    ]);
    assert.ok(error instanceof Error);
    assert.equal(error.message, "生成失败，请联系管理员");
    assert.equal(polls, 16);
    assert.deepEqual(progress, [50]);
    // 每两次查询之间都按 fit 生成台的间隔等
    assert.deepEqual(sleeps, Array(15).fill(VIDEO_POLL_INTERVAL_MS));
});

test("waitFitVideo：非临时错误连续 5 次（MAX_POLL_FAILURES）才报错，夹在中间的临时错误不清零；报的是最后一次的原因", async () => {
    assert.equal(MAX_POLL_FAILURES, 5);
    const { error, polls } = await waitWith([denied, badGateway, denied, denied, network, denied, missing, () => Response.json({ id: "task_w", status: "completed" })]);
    assert.ok(error instanceof FitRequestError, String(error));
    assert.deepEqual({ status: error.status, retryable: error.retryable, message: error.message }, { status: 404, retryable: false, message: "task not found" });
    assert.equal(polls, 7);
});

const PAID = "task_paid";
const SIGNED = `https://openai.fit/v1/tasks/${PAID}/artifacts/video/content?access=${"A".repeat(43)}`;
/** fit 插件取产物出错时回的样子（5c1c13d controller/task.go 的 writeTaskArtifactProjectionError，带 JSON 错误体）。 */
const pluginFailed = () => Response.json({ error: { message: "Artifact preview plugin failed", type: "artifact_plugin_error", code: "artifact_plugin_error" } }, { status: 500 });

/**
 * 已完成（已扣费）的任务：GET /v1/videos/task_paid 一直回 completed，/content 一直回 502 JSON；GET artifacts 按顺序取 deliveries 的桩，用完后给签名链接。
 * 签名链接被跨域拦下（直接交给播放器），全程不往浏览器存文件；parseTaskArtifactContentUrl 要读 window.location。stop 给了的话在下载 /content 时中止。
 */
async function withPaidTask(deliveries: Array<() => Response>, run: (counts: { status: number; artifacts: number }) => Promise<void>, stop?: AbortController) {
    const original = globalThis.fetch;
    const globals = globalThis as { window?: unknown };
    const hadWindow = "window" in globals;
    globals.window ??= { location: { protocol: "https:" } };
    const counts = { status: 0, artifacts: 0 };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === `https://openai.fit/v1/videos/${PAID}`) {
            counts.status += 1;
            return Response.json({ id: PAID, status: "completed", progress: 100 });
        }
        if (url === `https://openai.fit/v1/videos/${PAID}/content`) {
            stop?.abort();
            return Response.json({ error: { message: "upstream fetch failed" } }, { status: 502 });
        }
        if (url === `https://openai.fit/v1/tasks/${PAID}/artifacts`) return deliveries[counts.artifacts++]?.() ?? Response.json({ task_id: PAID, artifacts: [{ key: "video", type: "video", content_url: SIGNED }] });
        if (url === SIGNED) throw new TypeError("Failed to fetch");
        throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    try {
        await run(counts);
    } finally {
        globalThis.fetch = original;
        if (!hadWindow) delete globals.window;
    }
}

test("openai.fit 已报完成（已扣费）但取成片失败（artifacts 回带 JSON 错误体的 500）：连续 6 轮都是可重试错误，画布不判失败、视频工作台保持「生成中」；取片恢复后照常出片", async () => {
    await withPaidTask(Array(6).fill(pluginFailed), async () => {
        const failures = new Map<string, number>();
        let workbench = 0;
        for (let round = 0; round < 6; round += 1) {
            const error = await pollFitVideoTask(KEYS, { id: PAID, task_id: PAID, status: "processing", progress: 90 }).then(
                () => assert.fail("取不到成片时这一轮应该报错"),
                (caught: unknown) => caught,
            );
            assert.ok(error instanceof FitRequestError && error.retryable, String(error));
            assert.equal(error.message, "视频已生成，正在取回成片（上次没取到：Artifact preview plugin failed）");
            // 画布（canvas-client-page 的视频轮询）和视频工作台（pollPendingLogOnce）各自的判定
            assert.equal(fitPollFailure(failures, `node-1:${PAID}`, PAID, error), "");
            const next = videoPollFailure(error, workbench, true);
            workbench = next.failures;
            assert.equal(next.status, "生成中");
        }
        assert.equal(failures.size, 0);
        assert.equal(workbench, 0);
        const done = await pollFitVideoTask(KEYS, { id: PAID, task_id: PAID, status: "processing", progress: 90 });
        assert.deepEqual({ status: done.status, progress: done.progress, url: done.video_url }, { status: "completed", progress: 100, url: SIGNED });
    });
});

test("取成片时已经点了停止：原样抛出，不包成可重试的「正在取回成片」", async () => {
    const stop = new AbortController();
    await withPaidTask(
        [pluginFailed],
        async () => {
            const error = await pollFitVideoTask(KEYS, { id: PAID, task_id: PAID }, stop.signal).then(
                () => assert.fail("应该报错"),
                (caught: unknown) => caught,
            );
            assert.ok(!(error instanceof FitRequestError), String(error));
            assert.equal((error as Error).message, "Artifact preview plugin failed");
        },
        stop,
    );
});

test("waitFitVideo：已完成后取成片连续 6 次出错（JSON 500、404、没有视频产物）不计数、不报错，取片恢复后返回成片", async () => {
    const notFound = () => Response.json({ error: { message: "task not found" } }, { status: 404 });
    const noVideo = () => Response.json({ task_id: PAID, artifacts: [] });
    const original = globalThis.setTimeout;
    const sleeps: number[] = [];
    globalThis.setTimeout = ((resolve: () => void, ms?: number) => {
        sleeps.push(ms ?? 0);
        queueMicrotask(resolve);
        return 0;
    }) as unknown as typeof setTimeout;
    try {
        await withPaidTask([pluginFailed, pluginFailed, notFound, noVideo, pluginFailed, pluginFailed], async (counts) => {
            const result = await waitFitVideo(KEYS, { id: PAID, task_id: PAID });
            assert.equal(result.url, SIGNED);
            assert.equal(result.task.status, "completed");
            assert.deepEqual(counts, { status: 7, artifacts: 7 });
            assert.deepEqual(sleeps, Array(6).fill(VIDEO_POLL_INTERVAL_MS));
        });
    } finally {
        globalThis.setTimeout = original;
    }
});
