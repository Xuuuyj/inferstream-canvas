import { fitKeyFor, fitKeySet, missingFitKeyMessage } from "@/lib/fit-config";
import { dataUrlToBlob, sendRelayRequest } from "@/lib/fit-generate/lib/relay-client";
import { acceptedReferences, buildRelayRequest, extractImageResults } from "@/lib/fit-generate/lib/request-builders";
import { validateSubmission } from "@/lib/fit-generate/lib/validate-submission";
import type { GenerationFormValues, ModelProfile, RelayRequest } from "@/lib/fit-generate/types";
import { fetchViaProxy, getProxyUrl } from "@/services/image-storage";
import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { loadFitStudio } from "./catalog";
import { fitAuthHeaders, fitFetch } from "./transport";
import { canvasToFitValues, fitIssueText } from "./values";
import { hostReferences } from "./video";

const BACKUP_ATTEMPTS = 3;
const BACKUP_RETRY_MS = 3000;

/** fit 生成库的请求不收 AbortSignal：停止只是不再等结果，已经发出的请求照常扣费。 */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal) {
    if (!signal) return promise;
    const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    return Promise.race([promise, aborted]);
}

/** 一张结果读成 Blob：data: 直接转；openai.fit 和它的 OSS 域名浏览器直接取；其他域名走同源的 /api/proxy-image。 */
async function resultBlob(source: string, apiKey: string) {
    if (source.startsWith("data:")) return dataUrlToBlob(source, /^data:([^;,]+)/.exec(source)?.[1] || "image/png");
    const response = getProxyUrl(source) === source ? await fitFetch(source, { headers: fitAuthHeaders(source, apiKey) }) : await fetchViaProxy(source);
    if (!response.ok || /json/i.test(response.headers.get("content-type") || "")) throw new Error(`读取生成的图片失败：${response.status}`);
    return response.blob();
}

/**
 * 第二道兜底：fit 给每次出图建一条 img-<请求 id> 的备份任务（id 的写法同 fit 的 sanitizeBackupKeyPart），图片按返回顺序编号 0、1、2…。
 * 带令牌、不带 access 参数时由 fit 自己转发备份图，不依赖 OSS 的跨域设置。备份在出图返回后才异步写入，查不到时稍等再试。
 */
async function backupBlob(requestId: string, index: number, apiKey: string) {
    const taskId = `img-${requestId
        .trim()
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .slice(0, 128)}`;
    for (let attempt = 1; ; attempt += 1) {
        const response = await fitFetch(`/v1/tasks/${encodeURIComponent(taskId)}/artifacts/${index}/content`, { headers: { Authorization: `Bearer ${apiKey}` } });
        if (response.ok) return response.blob();
        if (response.status !== 404 || attempt >= BACKUP_ATTEMPTS) throw new Error(`读取原模型服务备份图失败：${response.status}`);
        await new Promise((resolve) => setTimeout(resolve, BACKUP_RETRY_MS));
    }
}

/** 一个单张请求：发出去、取出结果；某张图读不到时按请求 id 找备份（要 fit 放开 X-Oneapi-Request-Id 响应头，读不到 id 就直接报错）。 */
async function sendOnce(request: RelayRequest, apiKey: string) {
    const relay = await sendRelayRequest(request, apiKey);
    const { images, text } = extractImageResults(relay.data);
    if (!images.length) throw new Error(text || "原模型服务没有返回图片");
    return Promise.all(
        images.map((source, index) =>
            resultBlob(source, apiKey).catch((error: unknown) => {
                if (!relay.requestId) throw error;
                return backupBlob(relay.requestId, index, apiKey).catch(() => Promise.reject(error));
            }),
        ),
    );
}

/**
 * 和 fit 生成台 runner 的 submit 同一流程（不分图片视频）：只留卡片收的素材 → 补边到所选画幅 → 要托管的传到 /v1/uploads 换成链接
 * （hostReferences，和视频共用）→ buildRelayRequest。今天在售的图片卡都不补边、不托管，请求体和直接 buildRelayRequest 一样。
 */
export async function fitImageRequest(profile: ModelProfile, values: GenerationFormValues, apiKey: string) {
    return buildRelayRequest(profile, { ...values, references: await hostReferences(profile, values.aspectRatio, acceptedReferences(profile, values.references), apiKey) });
}

/**
 * 画布出图走 openai.fit 生成台的契约：canvasToFitValues → validateSubmission（不合法就不发请求、不扣钱）→ fitImageRequest。
 * fit 的构造器固定 n 为 1，要几张就并发发几个单张请求；有成功的就返回成功的图，全部失败时报第一个错误。
 * 上传参考图、出图、读结果图和备份图都用图片令牌。
 */
export async function requestFitImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, signal?: AbortSignal): Promise<Blob[]> {
    const apiKey = fitKeyFor(config, "image");
    if (!apiKey) throw new Error(missingFitKeyMessage("image"));
    const { profiles } = await loadFitStudio(fitKeySet(config));
    const profile = Object.hasOwn(profiles, config.model) ? profiles[config.model] : null;
    if (profile?.kind !== "image") throw new Error(`当前原模型服务令牌不能用 ${config.model} 出图，请在设置里重新验证令牌`);
    const values = await canvasToFitValues(profile, config, prompt, { references });
    const issues = validateSubmission(profile, values);
    if (issues.length) throw new Error(fitIssueText(issues));
    signal?.throwIfAborted();
    const request = await fitImageRequest(profile, values, apiKey);
    signal?.throwIfAborted();
    const results = await Promise.allSettled(Array.from({ length: count }, () => untilAborted(sendOnce(request, apiKey), signal)));
    signal?.throwIfAborted();
    const blobs = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    if (blobs.length) return blobs;
    throw results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason;
}
