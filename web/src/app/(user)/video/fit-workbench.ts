import axios from "axios";

import { fitKeySet, isFitConfig } from "@/lib/fit-config";
import { MAX_POLL_FAILURES, MAX_REFERENCE_MEDIA_BYTES, MAX_REFERENCE_UPLOAD_BYTES } from "@/lib/fit-generate/constants";
import type { ModelProfile } from "@/lib/fit-generate/types";
import { seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { fitProfileFor, loadFitStudio } from "@/services/api/fit/catalog";
import { FitRequestError, type FitVideoResponse } from "@/services/api/fit/video";
import { isRetryableWorkflowError } from "@/services/api/workflow-generation";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

/** 轮询出错是不是临时的（断网、408、429、5xx）：是的话日志保持「生成中」，下一轮接着查。openai.fit 走 fetch，看 FitRequestError 的 retryable。 */
export function isTransientVideoPollError(error: unknown) {
    if (error instanceof FitRequestError) return error.retryable;
    if (isRetryableWorkflowError(error)) return true;
    if (!axios.isAxiosError(error)) return false;
    const status = error.response?.status;
    return !error.response || status === 408 || status === 429 || Boolean(status && status >= 500);
}

/**
 * 一次轮询出错后的日志状态和非临时错误的累计次数。临时错误一直接着查、不计数；其他错误别的渠道立即判失败，
 * openai.fit 的任务照 fit 生成台累计 MAX_POLL_FAILURES（5）次才判失败（查成功一次由调用方清零）：fit 没有取消接口，过早判失败的任务照样出片扣费。
 */
export function videoPollFailure(error: unknown, previousFailures: number, fit: boolean) {
    if (isTransientVideoPollError(error)) return { failures: previousFailures, status: "生成中" as const };
    const failures = previousFailures + 1;
    return { failures, status: !fit || failures >= MAX_POLL_FAILURES ? ("失败" as const) : ("生成中" as const) };
}

/**
 * openai.fit 的视频配置提交时不再走旧渠道的归一化（会把 4:3、1:1、adaptive 改成 1280x720）：画幅、清晰度、时长原样交给 canvasToFitValues，
 * 和参数面板、底部快捷选项显示的是同一份。不是 fit 配置时返回 null。
 */
export function fitVideoConfig(config: AiConfig, model: string): AiConfig | null {
    return isFitConfig(config) ? { ...config, model, videoModel: model } : null;
}

/**
 * 提交前按旧渠道规则查参考视频（seedanceVideoReferenceError：每段 2–15 秒、合计不超过 15 秒、像素和宽高比；ark 的 seedance 2.5 换一套 limits）。
 * openai.fit 不查：卡片各有各的限制（例如 wan3.0-video-prime-GT 不限片长），交给 createFitVideoTask 里的 validateSubmission 按卡片查。空串表示这一步放行。
 */
export function legacyVideoReferenceError(config: AiConfig, videoReferences: ReferenceVideo[], limits: typeof SEEDANCE_REFERENCE_LIMITS) {
    return isFitConfig(config) ? "" : seedanceVideoReferenceError(videoReferences, limits);
}

/**
 * 添加参考音频时按旧渠道规则筛时长（单个 2 秒到 limits.maxDurationMs、合计不超过 limits.totalDurationMs），超出的忽略并提示。
 * openai.fit 不筛：卡片各有各的限制（例如 seedance 2.5-GT 参考音频合计可到 30 秒），交给 createFitVideoTask 里的 validateSubmission 按卡片查；
 * file-storage 现在会读出音频片长，不跳过的话旧规则会在添加时就把这些音频截掉。
 */
export function legacyAudioReferences(config: AiConfig, existing: ReferenceAudio[], next: ReferenceAudio[], limits: typeof SEEDANCE_REFERENCE_LIMITS, warn: (content: string) => void) {
    if (isFitConfig(config)) return next;
    let total = existing.reduce((sum, item) => sum + (item.durationMs || 0), 0);
    const accepted: ReferenceAudio[] = [];
    let skipped = false;
    for (const item of next) {
        if (item.durationMs && (item.durationMs < 2000 || item.durationMs > limits.maxDurationMs)) {
            skipped = true;
            continue;
        }
        if (item.durationMs && total + item.durationMs > limits.totalDurationMs) {
            skipped = true;
            continue;
        }
        total += item.durationMs || 0;
        accepted.push(item);
    }
    if (skipped) warn(`已忽略不符合时长要求的参考音频：单个 2-${limits.maxDurationMs / 1000} 秒，总时长不超过 ${limits.totalDurationMs / 1000} 秒`);
    return accepted;
}

/** 视频工作台添加参考素材的上限：参考图、视频、音频各自最多几个，单个文件最大多少字节。 */
export type WorkbenchReferenceLimits = { images: number; videos: number; audios: number; imageMaxBytes: number; videoMaxBytes: number; audioMaxBytes: number };

/**
 * 添加参考素材时用的上限。别的渠道照旧用 legacy（旧 seedance / ark 的个数和大小，Kling 另算）；openai.fit 按卡片：个数取 profile.limits 的
 * image、video、audio（卡片不收的种类是 0），卡片还没读到时不截，交给提交时的 validateSubmission。卡片里没有单个文件大小，
 * 大小照 fit 生成台添加素材的上限（图片 40MB，提交前会缩小；音视频 100MB）。
 */
export function workbenchReferenceLimits(config: AiConfig, profile: ModelProfile | null, legacy: WorkbenchReferenceLimits): WorkbenchReferenceLimits {
    if (config.videoWorkflowRef || !isFitConfig(config)) return legacy;
    return {
        images: profile?.limits.image ?? Infinity,
        videos: profile?.limits.video ?? Infinity,
        audios: profile?.limits.audio ?? Infinity,
        imageMaxBytes: MAX_REFERENCE_UPLOAD_BYTES,
        videoMaxBytes: MAX_REFERENCE_MEDIA_BYTES,
        audioMaxBytes: MAX_REFERENCE_MEDIA_BYTES,
    };
}

/** 参考素材加不进去时的提示：卡片不收这种素材时直说，满了说最多几个。 */
export function referenceCountNotice(label: string, max: number, unit: string) {
    return max > 0 ? `${label}最多 ${max} ${unit}，多出的已忽略` : `当前模型不收${label}`;
}

/** 参考素材栏空着时的提示（note 接在后面）：卡片还没读到（上限是 Infinity）不写上限，卡片不收这种素材时直说。 */
export function emptyReferenceHint(label: string, max: number, unit: string, note = "") {
    if (max <= 0) return `当前模型不收${label}`;
    return `暂无${label}${Number.isFinite(max) ? `，最多 ${max} ${unit}` : ""}${note}`;
}

/** 添加一批参考素材：超过 maxBytes 的忽略，超出剩余名额（max 减去已有的）的截掉；notices 是要给用户的提示，全部收下时为空。 */
export function pickReferences<T extends { size: number }>(items: T[], existing: number, max: number, maxBytes: number, label: string, unit: string) {
    const small = items.filter((item) => item.size <= maxBytes);
    const picked = small.slice(0, Math.max(0, max - existing));
    const notices = [small.length < items.length ? `已忽略超过 ${maxBytes / 1024 / 1024}MB 的${label}` : "", picked.length < small.length ? referenceCountNotice(label, max, unit) : ""].filter(Boolean);
    return { picked, notices };
}

/**
 * 提交前要等的 openai.fit 卡片：首尾帧按卡片判断（supportsVideoFrameReferences 读 fitProfileFor），这张卡一次都没读到时先等 loadFitStudio（失败吞掉，由提交报原因）。
 * 读到过就不等、返回 undefined：60 秒缓存过期后 fitProfileFor 仍查得到上一份，提交时 createFitVideoTask 会重新读卡片、按最新的校验。
 */
export function fitCardsToWait(config: AiConfig, model: string): Promise<unknown> | undefined {
    return isFitConfig(config) && !fitProfileFor(model) ? loadFitStudio(fitKeySet(config)).catch(() => undefined) : undefined;
}

/**
 * 视频工作台的提交锁：同一个 key（生成，或某张结果卡、某条记录的重试）上一次还没走完时再触发直接忽略，免得等卡片时双击、连按回车提交两次、扣两次费。
 * 不用等（wait 为空）时 run 同步执行，提示词在点击当下清空、按钮随即变灰，和原来一样；run 走完（包括报错、校验没过）就解锁。
 */
export async function submitOnce<T>(locks: Set<string>, key: string, wait: Promise<unknown> | undefined, run: () => T | Promise<T>): Promise<T | undefined> {
    if (locks.has(key)) return undefined;
    locks.add(key);
    try {
        if (wait) await wait;
        return await run();
    } finally {
        locks.delete(key);
    }
}

/** 成片宽高：openai.fit 完成时带 mediaSize（成片实际宽高，size 留着用户选的画幅，例如 adaptive）；别的渠道从 size 的 WxH 读，读不到按 1280x720。 */
export function videoTaskSize(task: Pick<FitVideoResponse, "size" | "mediaSize">) {
    if (task.mediaSize) return { width: task.mediaSize.width, height: task.mediaSize.height };
    const match = typeof task.size === "string" ? task.size.match(/^(\d+)x(\d+)$/) : null;
    return { width: match ? Number(match[1]) : 1280, height: match ? Number(match[2]) : 720 };
}
