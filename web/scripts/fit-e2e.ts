/**
 * 付费端到端验收（docs/fit/P2-ACCEPTANCE.md）的执行器：每张代表卡按画布真实的提交路径真的发给 openai.fit，存下成片、图片和每张卡的记录。
 * - 视频：createFitVideoTask → pollFitVideoTask（照 waitFitVideo 的出错规则轮询，存成片的函数换成写进 --out）；
 * - 图片：requestFitImages（canvasToFitValues → validateSubmission → fitImageRequest → 并发单张请求、取结果），图片写进 --out；
 * - 文本：画布文本节点用的 requestImageQuestion（{model, messages, stream: true}，流式出字）。
 * 用例、素材参数、目录和打桩都来自 fit-acceptance.ts。成片和图片不进浏览器存储（IndexedDB）；画布服务器一个接口都不连：
 * /api/fit/catalog 换成只读 GET 的 openai.fit 公开目录，结果图要走 /api/proxy-image 时改成直接取原地址（记进卡片记录）。
 *
 *   FIT_E2E_KEY=<令牌> bun scripts/fit-e2e.ts --paid --out <目录> --image a --image b --image c --video v --audio a --video-prompt p --image-prompt p
 *       [--only V1,I2] [--expect <期望请求.md>] [--text-model <模型>] [--video-seconds 5 --audio-seconds 8]
 *   bun scripts/fit-e2e.ts --stub --out <目录> [同上]     # 不发任何请求，fetch 用 fit-acceptance.ts 的打桩
 * --paid 没给齐素材参数（--image ×3、--video、--audio、--video-prompt、--image-prompt）或文件不存在时，联网前以退出码 2 结束。
 *
 * 令牌只从环境变量 FIT_E2E_KEY 读（--stub 没给时用假令牌），不打印、不写文件。每张卡只提交一次，失败不重试；视频按顺序提交、一起轮询，每单最多等
 * --video-timeout-minutes（默认 25）分钟。提交出去的任务号马上写进 <out>/submitted.json，Ctrl+C 中断时补记还没返回的请求。
 * 每张卡的记录是 <out>/<编号>.json，汇总在 <out>/summary.json（多次运行按编号合并）。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { ALL_FORMATS, BufferSource, Input } from "mediabunny";
import { applyFitModels, normalizeFitApiKey } from "@/lib/fit-config";
import { MAX_POLL_FAILURES, VIDEO_POLL_INTERVAL_MS } from "@/lib/fit-generate/constants";
import { extractImageResults } from "@/lib/fit-generate/lib/request-builders";
import { clearHostedUploadCache } from "@/lib/fit-generate/lib/upload-client";
import { FIT_ORIGIN } from "@/lib/model-channel";
import { loadFitStudio } from "@/services/api/fit/catalog";
import { requestFitImages } from "@/services/api/fit/image";
import { FitRequestError, createFitVideoTask, pollFitVideoTask, type FitVideoConfig, type FitVideoResponse } from "@/services/api/fit/video";
import { requestImageQuestion } from "@/services/api/image";
import type { VideoResponse } from "@/services/api/video";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import { API_KEY, CASES, MATERIAL_OPTIONS, canvasInput, createRedactor, headerNote, loadCatalog, loadMaterials, refsText, stubCanvasCatalog, stubFitFetch, type Case } from "./fit-acceptance";

type Kind = "video" | "image" | "text";
type Exchange = { method: string; url: string; init?: RequestInit; status?: number; ms?: number; requestId?: string; contentType?: string; json?: unknown; error?: string; via?: string; pending: boolean };
type Expected = { model: string; precheck: string; uploads: string[]; uploadHeader?: string; count: number; method?: string; url?: string; header?: string; body?: unknown };
type CardRecord = Record<string, unknown> & { id: string; model: string; problems: string[]; notes: string[]; taskId?: string };

/** 画布在 https 页面里跑：fit 生成库和文本请求要用 window 的计时器和 location（签名链接只认 https 页面）。 */
const CANVAS_PAGE = "https://canvas.openai.fit/";
const UPLOADS = `${FIT_ORIGIN}/v1/uploads`;

const { values: args } = parseArgs({
    options: {
        ...MATERIAL_OPTIONS,
        stub: { type: "boolean", default: false },
        paid: { type: "boolean", default: false },
        only: { type: "string" },
        out: { type: "string" },
        expect: { type: "string" },
        "text-model": { type: "string" },
        "video-timeout-minutes": { type: "string", default: "25" },
    },
});

function fail(message: string): never {
    console.error(message);
    process.exit(2);
}

if (args.stub === args.paid) fail("要选一种：--stub（打桩，不发请求）或 --paid（真的发给 openai.fit，会扣费）");
if (!args.out) fail("缺少 --out <目录>");
if (args.paid) {
    // 没给齐素材时 loadMaterials 会用同名假字节和占位短句，--paid 下就真的发出去扣费了：联网前停下
    const missing = [(args.image?.length ?? 0) !== 3 && "--image ×3", !args.video && "--video", !args.audio && "--audio", !args["video-prompt"] && "--video-prompt", !args["image-prompt"] && "--image-prompt"].filter(Boolean);
    if (missing.length) fail(`--paid 要给齐素材参数，缺：${missing.join("、")}`);
    const absent = [...(args.image ?? []), args.video, args.audio, args["video-prompt"], args["image-prompt"]].filter((file) => file && !existsSync(file));
    if (absent.length) fail(`素材文件不存在：${absent.join("、")}`);
}
// --stub 也认 FIT_E2E_KEY（请求全打桩，发不出去），用来离线核对令牌不落盘
const rawKey = (process.env.FIT_E2E_KEY || (args.stub ? API_KEY : "")).trim();
if (!rawKey) fail("--paid 要在环境变量 FIT_E2E_KEY 里给 openai.fit 令牌");
const KEY = normalizeFitApiKey(rawKey);
const secrets = [...new Set([KEY, rawKey, KEY.slice(3)])].filter((value) => value.length >= 8);
/** 写文件、打印前都过一遍：令牌换成 <令牌>。 */
const scrub = (text: string) => secrets.reduce((result, secret) => result.split(secret).join("<令牌>"), text);
const out = path.resolve(args.out);
const timeoutMinutes = Number(args["video-timeout-minutes"]);
if (!(timeoutMinutes > 0)) fail("--video-timeout-minutes 要是正数");

const m = loadMaterials(args);
const TEXT_PROMPT = `请把下面这段漫剧分镜提示词压缩成一句 30 字以内的中文分镜描述，只输出这一句：\n\n${m.prompts.video.slice(0, 600)}`;
const TEXT_LABEL = `<文本提示词：漫剧分镜改写（视频提示词前 600 字），${TEXT_PROMPT.length} 字>`;
const TEXT_CASE: Case = { id: "T1", model: args["text-model"] ?? "", title: "文本生成：POST /v1/chat/completions，{model, messages, stream: true}，流式出字", settings: {}, refs: {} };
const ALL = [...CASES, TEXT_CASE];
const wanted = args.only
    ? args.only
          .split(",")
          .map((id) => id.trim().toUpperCase())
          .filter(Boolean)
    : ALL.map((item) => item.id);
const unknown = wanted.filter((id) => !ALL.some((item) => item.id === id));
if (unknown.length) fail(`没有这些用例：${unknown.join("、")}（可选 ${ALL.map((item) => item.id).join(",")}）`);
const selected = ALL.filter((item) => wanted.includes(item.id));
if (selected.some((item) => item.id === "T1") && !TEXT_CASE.model) fail("跑 T1 要用 --text-model 指定文本模型");
const expected = args.expect ? parseExpected(readFileSync(args.expect, "utf8")) : null;
const kindOf = (item: Case): Kind => (item.id.startsWith("V") ? "video" : item.id.startsWith("I") ? "image" : "text");

mkdirSync(out, { recursive: true });
const writeJson = (name: string, value: unknown) => writeFileSync(path.join(out, name), `${scrub(JSON.stringify(value, null, 2))}\n`);
const readJson = <T>(name: string, fallback: T): T => (existsSync(path.join(out, name)) ? (JSON.parse(readFileSync(path.join(out, name), "utf8")) as T) : fallback);
const log = (text: string) => console.log(scrub(text));
const message = (error: unknown) => scrub(error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 只读 GET 公开目录（给了 --pricing/--caps 就用文件），要在装上记录用的 fetch 之前读，不算进卡片的请求。 */
const { tokenModels, catalog } = await loadCatalog(args);
stubCanvasCatalog(catalog);
if (typeof window === "undefined") Object.assign(globalThis, { window: { setTimeout, clearTimeout, location: new URL(CANVAS_PAGE) } });

const cardExchanges = new AsyncLocalStorage<Exchange[]>();
const uploadNames = new Map<string, string>();
const baseFetch = args.stub ? stubFitFetch(tokenModels, [], m.video.base64) : globalThis.fetch.bind(globalThis);
const { describeBody } = createRedactor(m, (url) => uploadNames.get(url));
const isGeneration = (method: string, url: string) => method === "POST" && (url === `${FIT_ORIGIN}/v1/videos` || url.startsWith(`${FIT_ORIGIN}/v1/images/`) || url.includes(":generateContent"));

/** 记下每个请求（按卡片分开），认出 /v1/uploads 回的链接，留下视频和出图请求的响应体；画布服务器的地址不发出去。 */
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    let url = input instanceof Request ? input.url : String(input);
    const method = (init?.method || "GET").toUpperCase();
    let via: string | undefined;
    if (!/^https?:\/\//i.test(url)) {
        const proxied = /^\/api\/proxy-image\?url=([^&]+)/.exec(url);
        if (!proxied) throw new Error(`fit-e2e 不连画布服务器：${method} ${url.split("?")[0]}`);
        // 画布服务器的 /api/proxy-image 只是替浏览器取原地址，这里直接取
        url = decodeURIComponent(proxied[1]);
        via = "画布 /api/proxy-image（这里改为直接取原地址）";
        input = url;
        init = { method, credentials: "omit" };
    }
    const entry: Exchange = { method, url, init, via, pending: true };
    cardExchanges.getStore()?.push(entry);
    const started = Date.now();
    try {
        const response = await baseFetch(input, init);
        Object.assign(entry, { status: response.status, ms: Date.now() - started, requestId: response.headers.get("X-Oneapi-Request-Id") || undefined, contentType: response.headers.get("Content-Type") || undefined, pending: false });
        if (url === UPLOADS || isGeneration(method, url)) {
            const json = (await response
                .clone()
                .json()
                .catch(() => null)) as { url?: unknown } | null;
            if (url !== UPLOADS) entry.json = json;
            else if (typeof json?.url === "string") uploadNames.set(json.url, uploadFileName(init));
        }
        return response;
    } catch (error) {
        Object.assign(entry, { error: message(error), ms: Date.now() - started, pending: false });
        throw error;
    }
}) as typeof fetch;

function uploadFileName(init?: RequestInit) {
    const file = init?.body instanceof FormData ? init.body.get("file") : null;
    return file instanceof File ? file.name : "（未知文件）";
}

/** 期望请求文件（fit-acceptance.ts 生成的 P2-ACCEPTANCE-requests.md）按编号拆开。 */
function parseExpected(md: string) {
    const cards = new Map<string, Expected>();
    for (const section of md.replace(/\r\n/g, "\n").split(/^## /m).slice(1)) {
        const [heading] = section.split("\n");
        const [id, ...model] = heading.trim().split(" ");
        const uploads = /^- 先上传：(.+?)，各一次 POST \S+（(.+)）$/m.exec(section);
        const send = /^- 生成请求：(\d+) 次 (\w+) (\S+)（(.+?)）(，请求体都相同)?$/m.exec(section);
        const body = /```json\n([\s\S]+?)\n```/.exec(section);
        cards.set(id, {
            model: model.join(" "),
            precheck: /^- 预检：(.+)$/m.exec(section)?.[1] ?? "",
            uploads: uploads ? uploads[1].split("、") : [],
            uploadHeader: uploads?.[2],
            count: send ? Number(send[1]) : 0,
            method: send?.[2],
            url: send?.[3],
            header: send?.[4],
            body: body ? JSON.parse(body[1]) : undefined,
        });
    }
    return cards;
}

/** 逐字段比：缺的、多的、不同的都列出来。 */
function diff(want: unknown, got: unknown, at: string, found: string[]) {
    const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
    if (Array.isArray(want) && Array.isArray(got)) {
        if (want.length !== got.length) found.push(`${at}：期望 ${want.length} 项，实际 ${got.length} 项`);
        want.forEach((item, index) => index < got.length && diff(item, got[index], `${at}[${index}]`, found));
    } else if (isObject(want) && isObject(got)) {
        for (const key of new Set([...Object.keys(want), ...Object.keys(got)])) {
            if (!(key in got)) found.push(`${at}.${key}：缺少（期望 ${JSON.stringify(want[key])}）`);
            else if (!(key in want)) found.push(`${at}.${key}：多出来（实际 ${JSON.stringify(got[key])}）`);
            else diff(want[key], got[key], `${at}.${key}`, found);
        }
    } else if (JSON.stringify(want) !== JSON.stringify(got)) found.push(`${at}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
    return found;
}

/** 地址只留 openai.fit 的路径；别的主机（OSS、上游）只记主机和端口，签名参数不落盘。 */
function shownUrl(url: string) {
    try {
        const parsed = new URL(url);
        return parsed.origin === FIT_ORIGIN ? `${parsed.origin}${parsed.pathname}${parsed.search ? "?…" : ""}` : `${parsed.protocol}//${hostPort(parsed)}/…`;
    } catch {
        return url.slice(0, 80);
    }
}

function hostPort(url: URL) {
    return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

async function videoFacts(bytes: Uint8Array) {
    try {
        const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
        const track = await input.getPrimaryVideoTrack();
        return { width: track?.displayWidth, height: track?.displayHeight, durationSeconds: Math.round((await input.computeDuration()) * 100) / 100 };
    } catch (error) {
        return { parseError: message(error) };
    }
}

/** 图片宽高用 sharp 读（next 带的）；装不上就不记。 */
async function imageFacts(bytes: Buffer) {
    try {
        const { default: sharp } = await import("sharp");
        const meta = await sharp(bytes).metadata();
        return { width: meta.width, height: meta.height, format: meta.format };
    } catch {
        return {};
    }
}

const submitted = readJson<Array<Record<string, unknown>>>("submitted.json", []);
function noteSubmitted(entry: Record<string, unknown>) {
    submitted.push({ at: new Date().toISOString(), mode: args.paid ? "paid" : "stub", ...entry });
    writeJson("submitted.json", submitted);
}

const records = new Map<string, { record: CardRecord; exchanges: Exchange[] }>();

/** 按 waitFitVideo 的规则轮询：断网、408、429、5xx 接着等不计数，其他错误连续 MAX_POLL_FAILURES 次才报错；超时就停（任务仍在 fit 上计费）。 */
async function waitVideo(config: FitVideoConfig, task: VideoResponse, deadline: number, save: (blob: Blob, remoteId: string) => Promise<{ url: string; storageKey: string; width?: number; height?: number }>, states: string[]) {
    const started = Date.now();
    const note = (text: string) => states.at(-1)?.endsWith(text) || states.push(`+${Math.round((Date.now() - started) / 1000)}s ${text}`);
    let current: FitVideoResponse = task;
    let failures = 0;
    for (;;) {
        if (Date.now() > deadline) throw new Error(`轮询超过 ${timeoutMinutes} 分钟还没完成，停止等待；任务 ${task.id} 仍在 openai.fit 上生成并计费`);
        try {
            current = await pollFitVideoTask(config, current, undefined, save);
            failures = 0;
        } catch (error) {
            note(`查询出错：${message(error)}`);
            if (!(error instanceof FitRequestError && error.retryable) && ++failures >= MAX_POLL_FAILURES) throw error;
            await sleep(Math.min(VIDEO_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
            continue;
        }
        note(`${current.status}${current.status === "processing" ? ` ${current.progress ?? 0}%` : ""}`);
        if (current.status === "failed") throw new Error(current.error?.message || "视频生成失败");
        if (current.status === "completed") return current;
        await sleep(Math.min(VIDEO_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
}

/** 视频提交之后：轮询到完成、成片写进 --out、记下成片大小、宽高、时长和取成片的方式。 */
async function finishVideo(item: Case, record: CardRecord, exchanges: Exchange[], config: FitVideoConfig, task: VideoResponse) {
    const states: string[] = [];
    const saved: { facts?: Record<string, unknown> } = {};
    const save = async (blob: Blob, remoteId: string) => {
        const bytes = Buffer.from(await blob.arrayBuffer());
        const file = `${item.id}-video.mp4`;
        writeFileSync(path.join(out, file), bytes);
        const facts = await videoFacts(bytes);
        saved.facts = { file, bytes: bytes.length, mime: blob.type, remoteId, ...facts };
        return { url: path.join(out, file), storageKey: "", width: "width" in facts ? facts.width : undefined, height: "height" in facts ? facts.height : undefined };
    };
    try {
        const done = await waitVideo(config, task, Date.now() + timeoutMinutes * 60_000, save, states);
        if (!saved.facts) record.problems.push("成片没下载下来（画布会把签名链接直接交给 <video> 播放，刷新后不在浏览器里）");
        record.video = { ...saved.facts, nodeSize: done.mediaSize ? `${done.mediaSize.width}x${done.mediaSize.height}` : null };
    } catch (error) {
        record.problems.push(`视频没完成：${message(error)}`);
    } finally {
        const polls = exchanges.filter((entry) => entry.method === "GET" && entry.url === `${FIT_ORIGIN}/v1/videos/${encodeURIComponent(task.id)}`);
        const contentGets = exchanges.filter((entry) => entry.method === "GET" && entry.url === `${FIT_ORIGIN}/v1/videos/${encodeURIComponent(task.id)}/content`).length;
        const signedFallback = exchanges.some((entry) => entry.url.includes("/v1/tasks/") && entry.url.endsWith("/artifacts"));
        record.states = states;
        record.polls = { count: polls.length, statuses: Object.fromEntries([...new Set(polls.map((entry) => entry.status ?? "出错"))].map((status) => [status, polls.filter((entry) => (entry.status ?? "出错") === status).length])) };
        Object.assign((record.video ??= {}) as Record<string, unknown>, { contentGets, signedFallback });
        if (saved.facts && contentGets !== 1 && !signedFallback) record.problems.push(`GET /v1/videos/{id}/content 发了 ${contentGets} 次（应该只发一次）`);
        const sent = exchanges.find((entry) => isGeneration(entry.method, entry.url));
        const body = (sent ? JSON.parse(String(sent.init?.body)) : {}) as { seconds?: number; duration?: number };
        const asked = Number(body.seconds ?? body.duration);
        const got = Number(saved.facts?.durationSeconds);
        if (asked && got && Math.abs(asked - got) > 1) record.notes.push(`请求 ${asked} 秒，成片 ${got} 秒（时长由上游决定，单独核对扣费）`);
        await finalize(item, record, exchanges);
    }
}

/** 一张卡：视频只提交（轮询另外跑），图片和文本跑完。 */
async function runCard(item: Case, background: Promise<void>[]) {
    const kind = kindOf(item);
    const promptKind = item.prompt ?? (kind === "video" ? "video" : "image");
    const record: CardRecord = {
        id: item.id,
        model: item.model,
        title: item.title,
        mode: args.paid ? "paid" : "stub",
        settings: Object.entries(item.settings)
            .map(([key, value]) => `${key}=${value}`)
            .join("，"),
        refs: kind === "text" ? "无" : refsText(m, item.refs),
        prompt: kind === "text" ? TEXT_LABEL : m.promptLabel(promptKind),
        startedAt: new Date().toISOString(),
        problems: [],
        notes: [],
    };
    const exchanges: Exchange[] = [];
    records.set(item.id, { record, exchanges });
    // 每张卡都按「这批素材第一次用」跑（和期望请求文件一样）；浏览器里同一内容 72 小时内复用，第二次起不再上传
    clearHostedUploadCache();
    await cardExchanges.run(exchanges, async () => {
        try {
            if (kind === "video") {
                const config: FitVideoConfig = { apiKey: KEY, model: item.model, videoModel: item.model, ...item.settings };
                const created = await createFitVideoTask(config, m.prompts.video, canvasInput(m, item.refs));
                record.taskId = created.pollId;
                noteSubmitted({ card: item.id, model: item.model, taskId: created.pollId });
                log(`${item.id} ${item.model}：已提交，任务号 ${created.pollId}，开始轮询`);
                void finalize(item, record, exchanges);
                background.push(cardExchanges.run(exchanges, () => finishVideo(item, record, exchanges, config, created.task)));
                return;
            }
            if (kind === "image") {
                const count = item.settings.count ?? 1;
                const config = { apiKey: KEY, model: item.model, ...item.settings, count: String(count) } as unknown as AiConfig;
                const blobs = await requestFitImages(config, m.prompts[promptKind], canvasInput(m, item.refs).references, count);
                const sources = exchanges.filter((entry) => isGeneration(entry.method, entry.url)).flatMap((entry) => (entry.json ? extractImageResults(entry.json).images : []));
                record.images = await Promise.all(
                    blobs.map(async (blob, index) => {
                        const bytes = Buffer.from(await blob.arrayBuffer());
                        const file = `${item.id}-image-${index + 1}.${{ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[blob.type] ?? "bin"}`;
                        writeFileSync(path.join(out, file), bytes);
                        const source = sources[index] ?? "";
                        const where = source.startsWith("data:") ? { source: "响应里内联的 base64（b64_json / inline_data），没有结果地址" } : source ? { source: "结果地址", hostPort: hostPort(new URL(source)) } : { source: "（没认出来）" };
                        return { file, bytes: bytes.length, mime: blob.type, ...(await imageFacts(bytes)), ...where };
                    }),
                );
                if (blobs.length !== count) record.problems.push(`要 ${count} 张，拿到 ${blobs.length} 张`);
            } else {
                // 画布的文本节点：令牌的 /v1/models 同步成模型列表（applyFitModels），再用 requestImageQuestion 发 {model, messages, stream: true}
                const list = await loadFitStudio(KEY);
                const config: AiConfig = { ...applyFitModels(defaultConfig, { apiKey: KEY, list }), model: item.model };
                if (!config.textModels.includes(item.model)) throw new Error(`这把令牌的 /v1/models 里没有文本模型「${item.model}」，画布不会把它列成文本模型`);
                let deltas = 0;
                const answer = await requestImageQuestion(config, [{ role: "user", content: TEXT_PROMPT }], () => {
                    deltas += 1;
                });
                writeFileSync(path.join(out, `${item.id}-answer.txt`), answer);
                const send = exchanges.find((entry) => entry.method === "POST");
                record.text = { file: `${item.id}-answer.txt`, chars: answer.length, deltas, contentType: send?.contentType };
                if (!/text\/event-stream/i.test(send?.contentType ?? "") || deltas < 1) record.problems.push("没有流式出字（响应不是 text/event-stream 或没有增量）");
            }
        } catch (error) {
            record.problems.push(`出错：${message(error)}`);
        }
        await finalize(item, record, exchanges);
    });
}

/** 和期望请求比对、整理请求清单、写 <编号>.json。视频卡提交时写一次，完成后再写一次。 */
async function compare(item: Case, record: CardRecord, exchanges: Exchange[]) {
    const kind = kindOf(item);
    const uploads = exchanges.filter((entry) => entry.method === "POST" && entry.url === UPLOADS);
    const sends = exchanges.filter((entry) => entry.method === "POST" && entry.url !== UPLOADS);
    const promptKind = item.prompt ?? (kind === "video" ? "video" : "image");
    const bodies = await Promise.all(
        sends.map((entry) => (kind === "text" ? { format: "application/json", body: JSON.parse(String(entry.init?.body), (_key, value) => (value === TEXT_PROMPT ? TEXT_LABEL : value)) } : describeBody(entry.init, promptKind))),
    );
    record.precheck = uploads.length || sends.length ? "校验通过" : "没发生成请求";
    record.uploads = uploads.map((entry) => ({ name: uploadFileName(entry.init), status: entry.status, ms: entry.ms, error: entry.error }));
    record.generation = sends.length
        ? {
              count: sends.length,
              method: sends[0].method,
              url: sends[0].url,
              header: headerNote(sends[0].init, KEY),
              statuses: sends.map((entry) => entry.status ?? entry.error),
              ms: sends.map((entry) => entry.ms),
              requestIds: sends.map((entry) => entry.requestId).filter(Boolean),
              body: bodies[0],
          }
        : null;
    const want: Expected | undefined =
        kind === "text"
            ? {
                  model: item.model,
                  precheck: "校验通过",
                  uploads: [],
                  count: 1,
                  method: "POST",
                  url: `${FIT_ORIGIN}/v1/chat/completions`,
                  header: "Authorization: Bearer <令牌>；credentials: （没写）",
                  body: { format: "application/json", body: { model: item.model, messages: [{ role: "user", content: TEXT_LABEL }], stream: true } },
              }
            : expected?.get(item.id);
    const diffs: string[] = [];
    if (!want) record.compare = { verdict: "未比对", diffs: [expected ? `期望请求文件里没有 ${item.id}` : "没给 --expect"] };
    else {
        if (want.model !== item.model) diffs.push(`期望请求文件里 ${item.id} 是 ${want.model}，用例是 ${item.model}`);
        if (want.precheck !== record.precheck) diffs.push(`预检：期望「${want.precheck}」，实际「${record.precheck}」`);
        const names = uploads.map((entry) => uploadFileName(entry.init)).sort();
        if (names.join("、") !== want.uploads.join("、")) diffs.push(`上传：期望 ${want.uploads.join("、") || "不上传"}，实际 ${names.join("、") || "没上传"}`);
        if (uploads.length && want.uploadHeader && headerNote(uploads[0].init, KEY) !== want.uploadHeader) diffs.push(`上传请求头：期望 ${want.uploadHeader}，实际 ${headerNote(uploads[0].init, KEY)}`);
        if (sends.length !== want.count) diffs.push(`生成请求：期望 ${want.count} 次，实际 ${sends.length} 次`);
        if (sends.length && `${sends[0].method} ${sends[0].url}` !== `${want.method} ${want.url}`) diffs.push(`生成请求地址：期望 ${want.method} ${want.url}，实际 ${sends[0].method} ${sends[0].url}`);
        if (sends.length && want.header && headerNote(sends[0].init, KEY) !== want.header) diffs.push(`生成请求头：期望 ${want.header}，实际 ${headerNote(sends[0].init, KEY)}`);
        if (bodies.length && want.body === undefined) diffs.push("期望请求文件里没有这张卡的请求体，没法比");
        if (bodies.length && want.body !== undefined) diff(want.body, bodies[0], "请求体", diffs);
        bodies.slice(1).forEach((body, index) => diff(bodies[0], body, `第 ${index + 2} 个请求体（应和第 1 个相同）`, diffs));
        record.compare = { verdict: diffs.length ? "不一致" : "一致", diffs };
    }
    record.requests = exchanges
        .filter((entry) => !(entry.method === "GET" && /\/v1\/videos\/[^/]+$/.test(entry.url)))
        .map((entry) => ({ method: entry.method, url: shownUrl(entry.url), status: entry.status, ms: entry.ms, requestId: entry.requestId, via: entry.via, error: entry.error, pending: entry.pending || undefined }));
}

/** 同一张卡的写入排队（视频卡提交时写一次、完成后再写一次），免得先算完的旧结果后写。 */
function finalize(item: Case, record: CardRecord, exchanges: Exchange[]) {
    const done = (writes.get(item.id) ?? Promise.resolve())
        .then(() => compare(item, record, exchanges))
        .then(() => {
            if (record.compare && (record.compare as { verdict: string }).verdict === "不一致") record.problems.push("请求和期望不一致（见 compare.diffs）");
            record.problems = [...new Set(record.problems)];
            record.finishedAt = new Date().toISOString();
            record.seconds = Math.round((Date.parse(String(record.finishedAt)) - Date.parse(String(record.startedAt))) / 1000);
            record.ok = !record.problems.length;
            const sends = exchanges.filter((entry) => entry.method === "POST" && entry.url !== UPLOADS);
            if (kindOf(item) !== "video" && sends.length) noteSubmitted({ card: item.id, model: item.model, requests: sends.map((entry) => ({ url: shownUrl(entry.url), status: entry.status ?? entry.error, requestId: entry.requestId })) });
            writeJson(`${item.id}.json`, record);
        });
    writes.set(item.id, done);
    return done;
}
const writes = new Map<string, Promise<void>>();

function onInterrupt() {
    for (const { record, exchanges } of records.values()) {
        const inFlight = exchanges.filter((entry) => entry.pending && entry.method === "POST").map((entry) => shownUrl(entry.url));
        if (record.taskId || inFlight.length) noteSubmitted({ interrupted: true, card: record.id, model: record.model, taskId: record.taskId, inFlight });
        writeJson(`${record.id}.json`, { ...record, interrupted: true, inFlight });
    }
    console.error("已中断：已提交的任务号和没返回的请求记在 submitted.json");
    process.exit(130);
}
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onInterrupt);

log(`${args.paid ? "付费验收（真的发给 openai.fit）" : "打桩自检（不发请求）"}：${selected.map((item) => item.id).join(",")}，结果写进 ${out}`);
const background: Promise<void>[] = [];
for (const item of selected) await runCard(item, background);
await Promise.all(background);
await Promise.all(writes.values());

const summary = readJson<{ cards?: Record<string, unknown> }>("summary.json", {});
for (const { record } of records.values()) {
    const video = record.video as Record<string, unknown> | undefined;
    const images = record.images as Array<Record<string, unknown>> | undefined;
    const result = video?.file
        ? `成片 ${video.width}x${video.height} ${video.durationSeconds} 秒 ${video.bytes} 字节`
        : images?.length
          ? `图片 ${images.map((image) => `${image.width}x${image.height}`).join("、")}`
          : record.text
            ? `文本 ${(record.text as { chars: number }).chars} 字`
            : "";
    summary.cards = {
        ...summary.cards,
        [record.id]: {
            model: record.model,
            mode: record.mode,
            ok: record.ok,
            compare: (record.compare as { verdict?: string } | undefined)?.verdict,
            taskId: record.taskId,
            requestIds: (record.generation as { requestIds?: string[] } | null)?.requestIds,
            result,
            problems: record.problems,
            notes: record.notes,
            seconds: record.seconds,
            finishedAt: record.finishedAt,
        },
    };
    log(
        `${record.id} ${record.model}：${record.ok ? "通过" : "不通过"}；请求比对 ${(record.compare as { verdict?: string }).verdict}${record.taskId ? `；任务号 ${record.taskId}` : ""}${result ? `；${result}` : ""}${record.problems.length ? `；问题：${record.problems.join("；")}` : ""}`,
    );
}
writeJson("summary.json", { ...summary, updatedAt: new Date().toISOString() });
process.exit([...records.values()].every(({ record }) => record.ok) ? 0 : 1);
