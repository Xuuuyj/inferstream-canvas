import { inferStreamDefaultVideoModel, inferStreamProxy, inferStreamToken, inferStreamVideoModels, missingInferStreamToken } from "@/lib/inferstream-image-access";
import type { ReferenceImage as FitReference } from "@/lib/fit-generate/types";
import { normalizeSeedanceRatio } from "@/lib/seedance-video";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { fitMentions, imageAsset, type Slot } from "./fit/values";
import type { CreatedVideoGenerationTask, VideoGenerationResult, VideoProgressHandler, VideoReferenceInput, VideoResponse } from "./video";

/**
 * InferStream 视频生成（2026-11-17）：经画布同源的 /inferstream/v1 调网关的 OpenAI videos 接口
 * （POST /v1/videos 提交、GET /v1/videos/{id} 查询、GET /v1/videos/{id}/content 取成片），用设置里选的视频 Key。
 * 成片下载一次存进浏览器。
 * 参考图（2026-11-17 起）：连进来的图片按 Seedance 的 content 列表发（参考图或首帧，内联 data URL），网关提交前把它们托管到上游再换成链接。
 * 提示词里的 @图片N 换成 Seedance 的 @图N / @首帧（和 openai.fit 生成台同一写法）。暂不支持尾帧、参考视频和参考音频。
 */

export const INFERSTREAM_VIDEO_POLL_INTERVAL_MS = 8000;
const MAX_POLL_FAILURES = 5;

export type InferStreamVideoConfig = Pick<AiConfig, "model" | "videoModel" | "vquality" | "size" | "videoSeconds" | "systemPrompt" | "systemPrompts"> & { fitMentionLabels?: Record<string, string> };
/** 读好内容的参考图（data URL），按发给网关的顺序。 */
export type InferStreamVideoReference = { role: "first_frame" | "reference"; dataUrl: string };
type SavedVideo = { url: string; storageKey: string };
type SaveVideo = (blob: Blob, remoteId: string) => Promise<SavedVideo>;

/** 网关请求失败；retryable 是断网、408、429、5xx 这类临时错误，轮询应该接着查。 */
export class InferStreamRequestError extends Error {
    status?: number;
    retryable: boolean;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "InferStreamRequestError";
        this.status = status;
        this.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
    }
}

function videoKey() {
    const key = inferStreamToken("video");
    if (!key) throw new Error(missingInferStreamToken("video"));
    return key;
}

async function gatewayFetch(path: string, init: RequestInit = {}) {
    try {
        return await fetch(`${inferStreamProxy}${path}`, { ...init, credentials: "omit", headers: { ...init.headers, Authorization: `Bearer ${videoKey()}` } });
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        if (error instanceof Error && error.message === missingInferStreamToken("video")) throw error;
        throw new InferStreamRequestError("连接 InferStream 失败，请检查网络后重试");
    }
}

async function errorFrom(response: Response, fallback: string) {
    const payload = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
    const message = payload?.error?.message?.replace(/\s*\(request id: [^)]*\)\s*$/, "") || `${fallback}（HTTP ${response.status}）`;
    return new InferStreamRequestError(message, response.status);
}

/** seedance-2.0-mini 最多 9 张参考图；首帧和普通参考图不能混用（openai.fit 卡片 seedance2.0 mini stable 的规则）。 */
export const INFERSTREAM_MAX_REFERENCE_IMAGES = 9;
/** 网关请求体上限 16 MB，参考图读成 data URL 后合计不超过这个数（留出提示词和 JSON 的余量）。 */
export const INFERSTREAM_MAX_REFERENCE_CHARS = 14 * 1024 * 1024;

/** 参考素材的组合 InferStream 收不收；收返回空串（不读素材内容）。 */
export function inferStreamReferenceIssue(input: VideoReferenceInput) {
    if (input.videoReferences?.length || input.audioReferences?.length) return "InferStream 视频暂不支持参考视频和参考音频，请只连图片。";
    if (input.lastFrame) return "InferStream 视频暂不支持尾帧，请把尾帧改成普通参考图或首帧。";
    const images = input.references?.length ?? 0;
    if (input.firstFrame && images) return "首帧和普通参考图不能同时使用，请只保留一种。";
    if (images > INFERSTREAM_MAX_REFERENCE_IMAGES) return `参考图最多 ${INFERSTREAM_MAX_REFERENCE_IMAGES} 张，现在连了 ${images} 张。`;
    return "";
}

function referenceSlots(input: VideoReferenceInput): Slot[] {
    return [...(input.firstFrame ? [["image", "first_frame", input.firstFrame] as const] : []), ...(input.references ?? []).map((image) => ["image", "reference", image] as const)];
}

function fitReferenceOf([kind, role, source]: Slot, index: number, dataUrl = ""): FitReference {
    return { id: `${index}-${source.id}`, name: source.name, kind, role, mimeType: source.type, dataUrl };
}

/** 提示词里画布的 @图片N 换成 Seedance 的写法；引用了没连进来的素材时报错。 */
function referencePrompt(config: InferStreamVideoConfig, prompt: string, input: VideoReferenceInput) {
    const slots = referenceSlots(input);
    return slots.length ? fitMentions(prompt, slots, slots.map((slot, index) => fitReferenceOf(slot, index)), config.fitMentionLabels) : prompt;
}

/** 读参考图内容（超过 1280 边长或 2MB 的先缩小成 JPEG），检查合计大小。 */
async function readReferences(input: VideoReferenceInput): Promise<InferStreamVideoReference[]> {
    const references: InferStreamVideoReference[] = [];
    for (const [, role, source] of referenceSlots(input)) {
        const { dataUrl } = await imageAsset(source as ReferenceImage);
        references.push({ role: role === "first_frame" ? "first_frame" : "reference", dataUrl });
    }
    if (references.reduce((sum, reference) => sum + reference.dataUrl.length, 0) > INFERSTREAM_MAX_REFERENCE_CHARS) throw new Error("参考图合计太大（超过约 10 MB），请减少张数或换小一点的图。");
    return references;
}

/** 画布的参数换成网关请求体；参数超出模型范围时直接报错，不发请求、不扣费。 */
export function inferStreamVideoBody(config: InferStreamVideoConfig, prompt: string, references: InferStreamVideoReference[] = []) {
    const model = config.model || config.videoModel || inferStreamDefaultVideoModel;
    const spec = inferStreamVideoModels[model];
    if (!spec) throw new Error(`InferStream 暂不支持视频模型「${model}」，请在模型里选择 ${Object.keys(inferStreamVideoModels).join("、")}。`);
    const secondsText = String(config.videoSeconds ?? "").trim();
    const seconds = secondsText ? Number(secondsText) : spec.seconds.default;
    if (!Number.isInteger(seconds) || seconds < spec.seconds.min || seconds > spec.seconds.max) throw new Error(`${model} 的时长需要在 ${spec.seconds.min}–${spec.seconds.max} 秒之间。`);
    const resolution = String(config.vquality || "720").replace(/p$/i, "");
    if (!spec.resolutions.includes(resolution)) throw new Error(`${model} 只支持 ${spec.resolutions.map((value) => `${value}p`).join("、")}。`);
    const ratio = normalizeSeedanceRatio(config.size || "");
    const systemPrompt = (config.systemPrompts?.video || config.systemPrompt || "").trim();
    const text = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    if (!text.trim()) throw new Error("请填写视频提示词。");
    return {
        model,
        prompt: text,
        // 上游各家对时长字段叫法不一（seconds / duration），两个都给
        seconds: String(seconds),
        duration: seconds,
        resolution: `${resolution}p`,
        ratio: spec.ratios.includes(ratio) ? ratio : spec.ratios[0],
        // Seedance 的 content 列表：文字在前，参考图按 @图N 的顺序（和 openai.fit 生成台 content 模式同形）
        ...(references.length
            ? { content: [{ type: "text", text }, ...references.map((reference) => ({ type: "image_url", image_url: { url: reference.dataUrl }, role: reference.role === "first_frame" ? "first_frame" : "reference_image" }))] }
            : {}),
    };
}

/** 提交前检查（不发请求）：有问题返回提示文案，没问题返回空串。 */
export function inferStreamVideoIssue(config: InferStreamVideoConfig, prompt: string, input: VideoReferenceInput) {
    const referenceIssue = inferStreamReferenceIssue(input);
    if (referenceIssue) return referenceIssue;
    try {
        inferStreamVideoBody(config, referencePrompt(config, prompt, input));
        return "";
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

export async function createInferStreamVideoTask(config: InferStreamVideoConfig, prompt: string, input: VideoReferenceInput, signal?: AbortSignal, onProgress?: VideoProgressHandler): Promise<CreatedVideoGenerationTask> {
    const referenceIssue = inferStreamReferenceIssue(input);
    if (referenceIssue) throw new Error(referenceIssue);
    const text = referencePrompt(config, prompt, input);
    inferStreamVideoBody(config, text);
    const body = inferStreamVideoBody(config, text, await readReferences(input));
    const startedAt = Date.now();
    signal?.throwIfAborted();
    const response = await gatewayFetch("/videos", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
    if (!response.ok) throw await errorFrom(response, "InferStream 视频提交失败");
    const payload = (await response.json().catch(() => null)) as { id?: unknown; status?: unknown } | null;
    const id = typeof payload?.id === "string" ? payload.id : "";
    if (!id) throw new Error("InferStream 收下了请求，但没有返回任务 ID");
    const task: VideoResponse = { id, task_id: id, model: body.model, status: "queued", progress: 0, seconds: body.seconds, channelName: "InferStream" };
    onProgress?.(0, task);
    return { task, pollId: id, startedAt, requestBody: body };
}

const downloads = new Map<string, Promise<SavedVideo>>();
const saveInBrowser: SaveVideo = async (blob, remoteId) => (await import("@/services/file-storage")).uploadMediaFile(blob, "generated-video", `video-content:inferstream:${remoteId}`);

async function downloadVideo(remoteId: string, save: SaveVideo) {
    const response = await gatewayFetch(`/videos/${encodeURIComponent(remoteId)}/content`);
    if (!response.ok) throw await errorFrom(response, "取回成片失败");
    const blob = await response.blob();
    if (!blob.size || /json|^text\//i.test(blob.type)) throw new InferStreamRequestError("InferStream 没有返回视频文件", 502);
    return save(blob.type.startsWith("video/") ? blob : new Blob([blob], { type: "video/mp4" }), remoteId);
}

/** 同一个任务同时只下载一次（画布和视频工作台可能同时在轮询）。 */
function downloadOnce(remoteId: string, save: SaveVideo) {
    const pending = downloads.get(remoteId) ?? downloadVideo(remoteId, save).finally(() => downloads.delete(remoteId));
    downloads.set(remoteId, pending);
    return pending;
}

/** 查一次任务；完成时把成片存进浏览器。成片取不到时抛可重试的错误，不把已扣费的任务标成失败。 */
export async function pollInferStreamVideoTask(task: VideoResponse, signal?: AbortSignal, save: SaveVideo = saveInBrowser): Promise<VideoResponse> {
    const remoteId = task.task_id || task.id;
    if (!remoteId || remoteId.startsWith("client_")) throw new Error("视频任务还在提交，InferStream 还没有返回任务号");
    signal?.throwIfAborted();
    const response = await gatewayFetch(`/videos/${encodeURIComponent(remoteId)}`, { signal });
    if (!response.ok) throw await errorFrom(response, "查询视频任务失败");
    const payload = (await response.json().catch(() => null)) as { status?: string; progress?: number; error?: { message?: string } } | null;
    const status = String(payload?.status ?? "").toLowerCase();
    const progress = Number.isFinite(Number(payload?.progress)) ? Math.max(0, Math.min(100, Number(payload?.progress))) : 0;
    const polled: VideoResponse = { ...task, id: remoteId, task_id: remoteId, progress };
    if (status === "failed") return { ...polled, status: "failed", error: { message: payload?.error?.message || "视频生成失败" } };
    if (status !== "completed") return { ...polled, status: status === "queued" ? "queued" : "processing" };
    const video = await downloadOnce(remoteId, save).catch((error: unknown) => {
        if (signal?.aborted) throw error;
        const cause = error instanceof Error ? error.message : String(error);
        throw new InferStreamRequestError(`视频已生成，正在取回成片（上次没取到：${cause}）`);
    });
    return { ...polled, status: "completed", progress: 100, video_url: video.url, url: video.url, storageKey: video.storageKey || undefined };
}

/** 一直轮询到完成，给一次等到底的调用用。临时错误接着等；其他错误连续 5 次才报错。 */
export async function waitInferStreamVideo(
    task: VideoResponse,
    { startedAt = Date.now(), initialDelayMs = 0, onProgress, onPoll, intervalMs = INFERSTREAM_VIDEO_POLL_INTERVAL_MS, save = saveInBrowser }: { startedAt?: number; initialDelayMs?: number; onProgress?: VideoProgressHandler; onPoll?: (task: VideoResponse) => void; intervalMs?: number; save?: SaveVideo } = {},
): Promise<VideoGenerationResult> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (initialDelayMs > 0) await sleep(initialDelayMs);
    let current = task;
    let failures = 0;
    for (;;) {
        try {
            current = await pollInferStreamVideoTask(current, undefined, save);
            failures = 0;
        } catch (error) {
            if (!(error instanceof InferStreamRequestError && error.retryable) && ++failures >= MAX_POLL_FAILURES) throw error;
            await sleep(intervalMs);
            continue;
        }
        onPoll?.(current);
        if (current.status === "failed") throw new Error(current.error?.message || "视频生成失败");
        onProgress?.(current.progress ?? 0, current);
        if (current.status === "completed") {
            return { id: current.id, url: current.video_url || "", durationMs: Date.now() - startedAt, width: 1280, height: 720, bytes: 0, mimeType: "video/mp4", task: current };
        }
        await sleep(intervalMs);
    }
}

/** 浏览器里的成片丢了时，从 InferStream 再取一次（只读已扣费的成片，不重新生成）。 */
export async function recoverInferStreamVideo(task: VideoResponse): Promise<SavedVideo> {
    const remoteId = task.task_id || task.id;
    if (!remoteId || remoteId.startsWith("client_")) throw new Error("这个视频没有 InferStream 任务号");
    const video = await downloadOnce(remoteId, saveInBrowser);
    if (!video.storageKey) throw new Error("InferStream 上已经取不到这条成片");
    return video;
}
