import { fitKeyFor, fitKeyForRef, fitKeyRef, fitKeySet, missingFitKeyMessage } from "@/lib/fit-config";
import { MAX_POLL_FAILURES, VIDEO_POLL_INTERVAL_MS } from "@/lib/fit-generate/constants";
import { planHostedUploads } from "@/lib/fit-generate/lib/hosting-plan";
import { padReferencesToRatio } from "@/lib/fit-generate/lib/reference-ratio";
import { getVideoContentUrl, readJson, sendRelayRequest, type RemoteVideoState } from "@/lib/fit-generate/lib/relay-client";
import { acceptedReferences, buildRelayRequest, relayErrorMessage } from "@/lib/fit-generate/lib/request-builders";
import { uploadReferenceFiles } from "@/lib/fit-generate/lib/upload-client";
import { validateSubmission } from "@/lib/fit-generate/lib/validate-submission";
import messages from "@/lib/fit-generate/messages.zh.json";
import type { ModelProfile, ReferenceAsset } from "@/lib/fit-generate/types";
import type { AiConfig } from "@/stores/use-config-store";
import type { CreatedVideoGenerationTask, VideoGenerationResult, VideoProgressHandler, VideoReferenceInput, VideoResponse } from "../video";
import { loadFitStudio } from "./catalog";
import { fitFetch } from "./transport";
import { canvasToFitValues, fitIssueText, type FitValuesConfig } from "./values";

/** fit 没有取消接口：画布的「停止」只停本地轮询，停止时要给用户看这句。 */
export const FIT_VIDEO_STOP_NOTICE = "已停止等待结果。原模型服务没有取消接口，已提交的任务仍会继续生成并计费";

export type FitVideoConfig = Pick<AiConfig, "fitKeys" | "fitManualKey" | "model" | "videoModel"> & FitValuesConfig;
/** 轮询和下载只需要令牌：按任务提交时记下的 fitKeyRef 找回同一把（见 fitKeyForRef）。 */
export type FitVideoKeyConfig = Pick<AiConfig, "fitKeys" | "fitManualKey">;
type SavedVideo = { url: string; storageKey: string; width?: number; height?: number };
/** 成片宽高走画布已有的 mediaSize（只定节点框和 naturalWidth/Height），不写进 size，免得盖掉用户选的画幅（例如 adaptive）。 */
export type FitVideoResponse = VideoResponse & { mediaSize?: { content: string; width: number; height: number } };
type SaveVideo = (blob: Blob, remoteId: string) => Promise<SavedVideo>;

const zh = messages as Record<string, string>;
const downloads = new Map<string, Promise<SavedVideo>>();

/** openai.fit 请求失败：status 是 HTTP 状态，连不上时没有；retryable 是断网、408、429、5xx 这类临时错误，轮询应该接着查。 */
export class FitRequestError extends Error {
    status?: number;
    retryable: boolean;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "FitRequestError";
        this.status = status;
        this.retryable = status === undefined || status === 408 || status === 429 || status >= 500;
    }
}

/**
 * fit 生成库抛的英文提示换成 fit 的中文文案；浏览器连不上 openai.fit（断网、跨域被拦）时说清楚。
 * 带 HTTP 状态的（包括 fit 生成库没有响应体时抛的「HTTP 502」）保留状态，好分临时错误。
 */
function fitError(error: unknown) {
    if (error instanceof TypeError && /fetch|network|load failed/i.test(error.message)) return new FitRequestError("连接原模型服务失败，请检查网络后重试");
    const message = error instanceof Error ? error.message : String(error);
    const text = zh[message] ?? message;
    if (error instanceof FitRequestError) return new FitRequestError(text, error.status);
    const status = Number(/^HTTP (\d{3})$/.exec(message)?.[1]);
    return status ? new FitRequestError(text, status) : new Error(text);
}

/**
 * 任务已完成（fit 已扣费）之后取成片出错，不管什么错误（例如 artifacts 回带 JSON 错误体的 500「Artifact preview plugin failed」）都算临时错误：
 * 画布、视频工作台、waitFitVideo 接着等，下一轮重新取成片。和 fit 生成台一样不把已完成的任务变成失败，免得用户点重试再扣一次费。
 */
function deliveryError(error: unknown) {
    const cause = fitError(error);
    return new FitRequestError(`视频已生成，正在取回成片（上次没取到：${cause.message}）`, cause instanceof FitRequestError && cause.retryable ? cause.status : undefined);
}

/**
 * GET /v1/videos/{id}，状态解析和 relay-client 的 getVideoTask 一样（同步副本不能改）；getVideoTask 出错时只抛文案、丢了 HTTP 状态，
 * 这里带上状态，画布和视频工作台才分得清 502、429 这类临时错误和真失败。
 */
async function videoTaskState(remoteId: string, apiKey: string): Promise<RemoteVideoState> {
    const response = await fitFetch(`/v1/videos/${encodeURIComponent(remoteId)}`, { headers: { Authorization: `Bearer ${apiKey}` } });
    const payload = (await readJson(response)) as Record<string, unknown> | null;
    if (!response.ok) throw new FitRequestError(relayErrorMessage(payload, response.status), response.status);
    const status = String(payload?.status ?? "").toLowerCase();
    const progress = Number(payload?.progress);
    const error = (payload?.error as { message?: unknown } | undefined)?.message;
    return {
        status: status === "queued" || status === "completed" || status === "failed" ? status : "in_progress",
        progress: Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : 0,
        error: typeof error === "string" ? error : null,
    };
}

/** 和 fit 生成台一样：图片先补边到所选画幅，再把要托管的素材传到 fit 的 /v1/uploads，换成 https 链接（同一内容 72 小时内复用）。 */
export async function hostReferences(profile: ModelProfile, aspectRatio: string | null, references: ReferenceAsset[], apiKey: string) {
    const padded = await padReferencesToRatio(profile, aspectRatio, references);
    const planned = new Set(planHostedUploads(padded, profile.limits));
    if (!planned.size) return padded;
    const hosted = await uploadReferenceFiles(
        padded.filter((asset) => planned.has(asset.id)),
        apiKey,
    );
    return padded.map((asset) => {
        const file = hosted.get(asset.id);
        return file ? { ...asset, dataUrl: file.url } : asset;
    });
}

/**
 * 按 fit 生成台的流程提交：换算参数 → validateSubmission（不合法直接报错，不发请求、不扣钱）→ 托管参考素材 → buildRelayRequest → POST /v1/videos。
 * prompt 传画布的原始提示词，系统提示词由 canvasToFitValues 拼。上传参考素材和提交都用视频令牌，任务上记下 fitKeyRef，轮询、下载用同一把。
 */
export async function createFitVideoTask(config: FitVideoConfig, prompt: string, input: VideoReferenceInput, signal?: AbortSignal, onProgress?: VideoProgressHandler): Promise<CreatedVideoGenerationTask> {
    const apiKey = fitKeyFor(config, "video");
    if (!apiKey) throw new Error(missingFitKeyMessage("video"));
    const model = config.model || config.videoModel;
    const { profiles } = await loadFitStudio(fitKeySet(config));
    const profile = Object.hasOwn(profiles, model) ? profiles[model] : null;
    if (profile?.kind !== "video") throw new Error(`原模型服务没有可用的视频模型「${model}」，请在设置里重新验证令牌并同步模型`);
    const values = await canvasToFitValues(profile, config, prompt, input);
    const issues = validateSubmission(profile, values);
    if (issues.length) throw new Error(fitIssueText(issues));
    const startedAt = Date.now();
    try {
        signal?.throwIfAborted();
        const references = await hostReferences(profile, values.aspectRatio, acceptedReferences(profile, values.references), apiKey);
        signal?.throwIfAborted();
        const request = buildRelayRequest(profile, { ...values, references });
        const payload = (await sendRelayRequest(request, apiKey)).data as { id?: unknown } | null;
        const remoteId = typeof payload?.id === "string" ? payload.id : "";
        if (!remoteId) throw new Error("原模型服务收下了请求，但没有返回任务 ID");
        const task: VideoResponse = { id: remoteId, task_id: remoteId, model: profile.modelName, status: "queued", progress: 0, fitKeyRef: fitKeyRef(config, "video") };
        onProgress?.(0, task);
        return { task, pollId: remoteId, startedAt, requestBody: request.transport === "json" ? request.body : request.fields };
    } catch (error) {
        throw signal?.aborted ? error : fitError(error);
    }
}

async function videoBlob(url: string, init?: RequestInit) {
    const response = await fitFetch(url, init);
    const blob = await response.blob();
    if (!response.ok || !blob.size || /json|^text\//i.test(blob.type)) throw new Error(`原模型服务没有返回视频文件：${response.status}`);
    return blob.type.startsWith("video/") ? blob : new Blob([blob], { type: "video/mp4" });
}

/** 存进浏览器（file-storage 的 uploadMediaFile，第一期是 IndexedDB），不调用 cacheProtectedVideo / uploadRemoteMediaToServer。 */
const saveInBrowser: SaveVideo = async (blob, remoteId) => (await import("@/services/file-storage")).uploadMediaFile(blob, "generated-video", `video-content:fit:${remoteId}`);

/**
 * 成片下载一次存进浏览器：先带令牌 GET /v1/videos/{id}/content（同一令牌反复整段下载会回 artifact_download_limited）；
 * 失败时改用签名链接（getVideoContentUrl，不带令牌，fit 302 到 OSS）再下一次；还不行就把签名链接直接交给 <video> 播放。
 */
async function downloadFitVideo(remoteId: string, apiKey: string, save: SaveVideo): Promise<SavedVideo> {
    try {
        return await save(await videoBlob(`/v1/videos/${encodeURIComponent(remoteId)}/content`, { headers: { Authorization: `Bearer ${apiKey}` } }), remoteId);
    } catch {
        const signed = await getVideoContentUrl(remoteId, apiKey);
        try {
            return await save(await videoBlob(signed), remoteId);
        } catch {
            return { url: signed, storageKey: "" };
        }
    }
}

/** 同一个任务同时只下载一次（画布和视频工作台可能同时在轮询）。 */
function downloadOnce(remoteId: string, apiKey: string, save: SaveVideo) {
    const pending = downloads.get(remoteId) ?? downloadFitVideo(remoteId, apiKey, save).finally(() => downloads.delete(remoteId));
    downloads.set(remoteId, pending);
    return pending;
}

/**
 * 画布里的成片在浏览器里没了（清缓存、空间不够被浏览器清掉、换了浏览器配置），本地文件夹里也没有时，从 openai.fit 再取一次存回浏览器。
 * 只读已经扣过费的成片，不提交、不扣费；fit 的 OSS 过了保存期（几天）就取不到，抛错。
 */
export async function recoverFitVideo(config: FitVideoKeyConfig, task: VideoResponse): Promise<SavedVideo> {
    const remoteId = task.task_id || task.id;
    if (!remoteId || remoteId.startsWith("client_")) throw new Error("这个视频没有原模型服务任务号");
    const apiKey = fitKeyForRef(config, task.fitKeyRef);
    if (!apiKey) throw new Error(missingFitKeyMessage("video"));
    const video = await downloadOnce(remoteId, apiKey, saveInBrowser);
    if (!video.storageKey) throw new Error("原模型服务上已经取不到这条成片");
    return video;
}

/** 查一次 GET /v1/videos/{id}：queued → queued，in_progress → processing，completed、failed 原样；完成时把成片存进浏览器，取不到成片抛可重试的错误（见 deliveryError）。 */
export async function pollFitVideoTask(config: FitVideoKeyConfig, task: VideoResponse, signal?: AbortSignal, save: SaveVideo = saveInBrowser): Promise<FitVideoResponse> {
    const remoteId = task.task_id || task.id;
    // 提交还没返回时画布也会来轮询，这时只有画布自己的 client_ 任务号，fit 上查不到。不发请求，抛错让画布的轮询忽略这一轮；
    // 不能原样返回，否则这一轮晚到的结果会把提交刚写进节点的 fit 任务号改回 client_ 号
    if (!remoteId || remoteId.startsWith("client_")) throw new Error("视频任务还在提交，原模型服务还没有返回任务号");
    try {
        signal?.throwIfAborted();
        const apiKey = fitKeyForRef(config, task.fitKeyRef);
        if (!apiKey) throw new Error(missingFitKeyMessage("video"));
        const state = await videoTaskState(remoteId, apiKey);
        const polled: VideoResponse = { ...task, id: remoteId, task_id: remoteId, progress: state.progress };
        if (state.status === "failed") return { ...polled, status: "failed", error: { message: state.error || "视频生成失败" } };
        if (state.status !== "completed") return { ...polled, status: state.status === "queued" ? "queued" : "processing" };
        const video = await downloadOnce(remoteId, apiKey, save).catch((error: unknown) => {
            throw signal?.aborted ? error : deliveryError(error);
        });
        return {
            ...polled,
            status: "completed",
            progress: 100,
            video_url: video.url,
            url: video.url,
            storageKey: video.storageKey || undefined,
            ...(video.width && video.height ? { mediaSize: { content: video.url, width: video.width, height: video.height } } : {}),
        };
    } catch (error) {
        throw signal?.aborted ? error : fitError(error);
    }
}

/**
 * 一直轮询到完成（按 fit 生成台的间隔），给 requestVideoGeneration 这类一次等到底的调用用。查询出错和视频工作台一样：断网、408、429、5xx
 * （FitRequestError.retryable，包括已完成后取成片出错）接着等、不计数；其他错误照 fit 生成台连续 MAX_POLL_FAILURES（5）次才报错，查成功一次清零。
 */
export async function waitFitVideo(
    config: FitVideoKeyConfig,
    task: VideoResponse,
    { startedAt = Date.now(), initialDelayMs = 0, onProgress, onPoll }: { startedAt?: number; initialDelayMs?: number; onProgress?: VideoProgressHandler; onPoll?: (task: VideoResponse) => void } = {},
): Promise<VideoGenerationResult> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    if (initialDelayMs > 0) await sleep(initialDelayMs);
    let current: FitVideoResponse = task;
    let failures = 0;
    for (;;) {
        try {
            current = await pollFitVideoTask(config, current);
            failures = 0;
        } catch (error) {
            if (!(error instanceof FitRequestError && error.retryable) && ++failures >= MAX_POLL_FAILURES) throw error;
            await sleep(VIDEO_POLL_INTERVAL_MS);
            continue;
        }
        onPoll?.(current);
        if (current.status === "failed") throw new Error(current.error?.message || "视频生成失败");
        onProgress?.(current.progress ?? 0, current);
        if (current.status === "completed") {
            const { width = 1280, height = 720 } = current.mediaSize ?? {};
            return { id: current.id, url: current.video_url || "", durationMs: Date.now() - startedAt, width, height, bytes: 0, mimeType: "video/mp4", task: current };
        }
        await sleep(VIDEO_POLL_INTERVAL_MS);
    }
}
