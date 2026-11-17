import type { ChatCompletionMessage } from "@/services/api/image";
import type { FitReferenceInput } from "@/services/api/fit/values";
import { isFitConfig } from "@/lib/fit-config";
import type { ModelProfile } from "@/lib/fit-generate/types";
import { fitAllowsEmptyPrompt } from "@/lib/fit-panel";
import { inferStreamVideoEnabled } from "@/lib/inferstream-image-access";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import type { WorkflowRef } from "@/lib/workflow-channel";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import type { AiConfig, VideoElementItem, VideoElementReference, VideoMultiPromptItem } from "@/stores/use-config-store";
import { CanvasNodeType, type CanvasConnection, type CanvasGenerationMode, type CanvasNodeData } from "../types";
import { isCanvasImageNodeType } from "../utils/canvas-panorama";
import { buildNodeMentionReferences, getGenerationResourceNodes } from "../utils/canvas-resource-references";

export type NodeGenerationContext = {
    prompt: string;
    /** 素材节点 id → 提示词里 @ 它用的标签（图片N / 视频N / 音频N），openai.fit 按它把 @ 引用换成同一个素材的写法。 */
    mentionLabels: Record<string, string>;
    referenceImages: ReferenceImage[];
    firstFrame: ReferenceImage | null;
    lastFrame: ReferenceImage | null;
    referenceVideos: ReferenceVideo[];
    referenceAudios: ReferenceAudio[];
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
    textCount: number;
    imageCount: number;
    videoCount: number;
    audioCount: number;
};

export type NodeGenerationInput = {
    nodeId: string;
    type: "text" | "image" | "video" | "audio";
    title: string;
    text?: string;
    image?: ReferenceImage;
    video?: ReferenceVideo;
    audio?: ReferenceAudio;
};

/**
 * 组装提示词要不要把素材写成 @图片N：openai.fit 出图、出视频和 InferStream 出视频（不走工作流）时，按 mentionLabels 把它换成同一个素材的写法；
 * 工作流、文本、语音和其他渠道照旧写「图片N」。
 */
export function composerMentionsFor(config: Parameters<typeof isFitConfig>[0], mode: CanvasGenerationMode, workflowRef?: unknown) {
    if (workflowRef) return false;
    return ((mode === "image" || mode === "video") && isFitConfig(config)) || (mode === "video" && inferStreamVideoEnabled());
}

/**
 * 节点按真正提交时的摆法交给 openai.fit 的素材（生成前的 fitPrecheck 和 fitNodeAllowsEmptyPrompt 共用）：
 * 视频卡片没有首尾帧用途时首尾帧并进参考图；图片节点改图时自己的原图（sourceImages）排在参考图后面。
 */
export function fitNodeReferenceInput(profile: ModelProfile, context: NodeGenerationContext, sourceImages: ReferenceImage[] = []): FitReferenceInput {
    if (profile.kind === "image") return { references: [...context.referenceImages, ...sourceImages] };
    const frames = profile.roles.some((role) => role !== "reference");
    const frameImages = [context.firstFrame, context.lastFrame].filter((image): image is ReferenceImage => Boolean(image));
    return { references: frames ? context.referenceImages : [...context.referenceImages, ...frameImages], firstFrame: frames ? context.firstFrame : null, lastFrame: frames ? context.lastFrame : null, videoReferences: context.referenceVideos, audioReferences: context.referenceAudios };
}

/**
 * 图片、视频节点能不能不写提示词、只发连进来的素材（提示词面板的生成按钮和重试都按它）：规则见 fitAllowsEmptyPrompt（fit 5c1c13d 只放行 seedance 2.5-GT），
 * 素材按 fitNodeReferenceInput 摆，只算连进来、有内容的素材（节点自己的原图不算）。workflowRef 是节点自己的工作流（全局的 videoWorkflowRef 不算），走工作流时不放行；
 * 卡片还没读到、没有上下文时返回 false，照旧要提示词。
 */
export function fitNodeAllowsEmptyPrompt(config: AiConfig, profile: ModelProfile | null, context: NodeGenerationContext | null, workflowRef?: WorkflowRef) {
    if (!profile || !context) return false;
    return fitAllowsEmptyPrompt({ ...config, videoWorkflowRef: workflowRef }, profile, fitNodeReferenceInput(profile, context));
}

/** mentions 见 composerMentionsFor，只影响组装提示词（配置节点的 composerContent）。 */
export function buildNodeGenerationContext(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[], prompt: string, mentions: boolean): NodeGenerationContext {
    const inputs = buildNodeGenerationInputs(nodeId, nodes, connections);
    const sourceNode = nodes.find((node) => node.id === nodeId);
    if (sourceNode?.type === CanvasNodeType.Config && Boolean(sourceNode.metadata?.composerContent?.trim())) {
        return buildComposerGenerationContext(inputs, prompt, mentions, sourceNode);
    }

    const advanced = buildCanvasVideoAdvancedContext(sourceNode, inputs);
    const upstreamText = sourceNode?.metadata?.excludeUpstreamText? "": inputs
            .filter((input) => !advanced.textNodeIds.has(input.nodeId))
            .map((input) => input.text)
            .filter(Boolean)
            .join("\n\n");
    const referenceImages = inputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = inputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = inputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const frameReferences = readFrameReferences(sourceNode, inputs);
    const frameNodeIds = new Set([frameReferences.firstFrame?.id, frameReferences.lastFrame?.id].filter((id): id is string => Boolean(id)));
    const effectiveReferenceImages = referenceImages.filter((image) => !frameNodeIds.has(image.id));
    // 和提示词输入框的 @ 候选同一套编号（按连线顺序数，首尾帧也算；没有输入时是节点自己）
    const mentionReferences = sourceNode ? buildNodeMentionReferences(sourceNode, nodes, connections) : [];

    return {
        prompt: upstreamText ? `${prompt}\n\n${upstreamText}` : prompt,
        mentionLabels: Object.fromEntries(mentionReferences.filter((reference) => reference.kind !== "text").map((reference) => [reference.nodeId, reference.label])),
        referenceImages: [...advanced.klingImageReferences, ...effectiveReferenceImages],
        firstFrame: frameReferences.firstFrame,
        lastFrame: frameReferences.lastFrame,
        referenceVideos,
        referenceAudios,
        videoMultiPrompt: advanced.videoMultiPrompt,
        videoElementList: advanced.videoElementList,
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

function buildComposerGenerationContext(inputs: NodeGenerationInput[], prompt: string, mentions: boolean, sourceNode?: CanvasNodeData): NodeGenerationContext {
    const advanced = buildCanvasVideoAdvancedContext(sourceNode, inputs);
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const selectedInputs: NodeGenerationInput[] = [];
    const labelByNodeId = new Map<string, string>();
    const textBlocks: string[] = [];
    const counts = { image: 0, video: 0, audio: 0, text: 0 };
    let hasToken = false;
    let lastIndex = 0;
    let nextPrompt = "";

    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        if (match.index === undefined) continue;
        hasToken = true;
        nextPrompt += prompt.slice(lastIndex, match.index);
        const input = inputByNodeId.get(match[1]);
        if (input && !advanced.textNodeIds.has(input.nodeId) && !advanced.referenceNodeIds.has(input.nodeId)) {
            let label = labelByNodeId.get(input.nodeId);
            if (!label) {
                label = generationLabel(input.type, counts[input.type]++);
                labelByNodeId.set(input.nodeId, label);
                if (input.type === "text") textBlocks.push(`【${label}】\n${input.text || ""}`);
                else selectedInputs.push(input);
            }
            // openai.fit 出图、出视频时素材写成 @图片N（和节点提示词里的 @ 引用同一写法），fit 才能按 mentionLabels 换成同一个素材的写法
            nextPrompt += input.type === "text" ? `【${label}】` : mentions ? `@${label}` : label;
        }
        lastIndex = match.index + match[0].length;
    }

    nextPrompt += prompt.slice(lastIndex);
    if (textBlocks.length) nextPrompt = `${nextPrompt.trim()}\n\n${textBlocks.join("\n\n")}`;
    const referenceImages = selectedInputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.image).filter((image): image is ReferenceImage => Boolean(image));
    const referenceVideos = selectedInputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.video).filter((video): video is ReferenceVideo => Boolean(video));
    const referenceAudios = selectedInputs.filter((input) => !advanced.referenceNodeIds.has(input.nodeId)).map((input) => input.audio).filter((audio): audio is ReferenceAudio => Boolean(audio));
    const frameReferences = readFrameReferences(sourceNode, inputs);
    const frameNodeIds = new Set([frameReferences.firstFrame?.id, frameReferences.lastFrame?.id].filter((id): id is string => Boolean(id)));
    const effectiveReferenceImages = referenceImages.filter((image) => !frameNodeIds.has(image.id));

    if (!hasToken) {
        return {
            prompt,
            mentionLabels: {},
            referenceImages: advanced.klingImageReferences,
            firstFrame: frameReferences.firstFrame,
            lastFrame: frameReferences.lastFrame,
            referenceVideos: [],
            referenceAudios: [],
            videoMultiPrompt: advanced.videoMultiPrompt,
            videoElementList: advanced.videoElementList,
            textCount: 0,
            imageCount: 0,
            videoCount: 0,
            audioCount: 0,
        };
    }

    return {
        prompt: nextPrompt,
        mentionLabels: Object.fromEntries([...labelByNodeId].filter(([nodeId]) => inputByNodeId.get(nodeId)?.type !== "text")),
        referenceImages: [...advanced.klingImageReferences, ...effectiveReferenceImages],
        firstFrame: frameReferences.firstFrame,
        lastFrame: frameReferences.lastFrame,
        referenceVideos,
        referenceAudios,
        videoMultiPrompt: advanced.videoMultiPrompt,
        videoElementList: advanced.videoElementList,
        textCount: counts.text,
        imageCount: referenceImages.length,
        videoCount: referenceVideos.length,
        audioCount: referenceAudios.length,
    };
}

type CanvasVideoAdvancedContext = {
    textNodeIds: Set<string>;
    referenceNodeIds: Set<string>;
    klingImageReferences: ReferenceImage[];
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
};

function buildCanvasVideoAdvancedContext(sourceNode: CanvasNodeData | undefined, inputs: NodeGenerationInput[]): CanvasVideoAdvancedContext {
    const inputByNodeId = new Map(inputs.map((input) => [input.nodeId, input]));
    const textNodeIds = new Set<string>();
    const referenceNodeIds = new Set<string>();
    const klingImageReferences = (sourceNode?.metadata?.klingImageNodeIds || [])
        .map((nodeId) => {
            referenceNodeIds.add(nodeId);
            return inputByNodeId.get(nodeId)?.image || null;
        })
        .filter((image): image is ReferenceImage => Boolean(image));
    const videoMultiPrompt = (sourceNode?.metadata?.klingMultiPrompt || [])
        .map((item) => {
            const nodeId = item.textNodeId || "";
            const input = inputByNodeId.get(nodeId);
            if (!nodeId || input?.type !== "text" || !input.text) return null;
            textNodeIds.add(nodeId);
            return { prompt: input.text, duration: item.duration || "1" };
        })
        .filter((item): item is VideoMultiPromptItem => Boolean(item));
    const videoElementList = (sourceNode?.metadata?.klingElementList || [])
        .slice(0, 3)
        .map((item) => {
            const references = (item.nodeIds || [])
                .slice(0, 4)
                .map((nodeId) => {
                    referenceNodeIds.add(nodeId);
                    return inputToElementReference(inputByNodeId.get(nodeId));
                })
                .filter((reference): reference is VideoElementReference => Boolean(reference));
            return references.length ? { name: item.name || "", description: item.description || "", references } : null;
        })
        .filter((item): item is VideoElementItem => Boolean(item));
    return { textNodeIds, referenceNodeIds, klingImageReferences, videoMultiPrompt, videoElementList };
}

function inputToElementReference(input: NodeGenerationInput | undefined): VideoElementReference | null {
    if (input?.image) return { id: input.nodeId, kind: "image", name: input.image.name, type: input.image.type, dataUrl: input.image.dataUrl, storageKey: input.image.storageKey };
    if (input?.video) return { id: input.nodeId, kind: "video", name: input.video.name, type: input.video.type, url: input.video.url, storageKey: input.video.storageKey, bytes: input.video.bytes, width: input.video.width, height: input.video.height, durationMs: input.video.durationMs };
    if (input?.audio) return { id: input.nodeId, kind: "audio", name: input.audio.name, type: input.audio.type, url: input.audio.url, storageKey: input.audio.storageKey, durationMs: input.audio.durationMs };
    return null;
}

export function buildNodeGenerationInputs(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): NodeGenerationInput[] {
    return getGenerationResourceNodes(nodeId, nodes, connections).flatMap((node): NodeGenerationInput[] => {
        const image = readReferenceImage(node);
        if (image) return [{ nodeId: node.id, type: "image" as const, title: node.title, image }];
        const video = readReferenceVideo(node);
        if (video) return [{ nodeId: node.id, type: "video" as const, title: node.title, video }];
        const audio = readReferenceAudio(node);
        if (audio) return [{ nodeId: node.id, type: "audio" as const, title: node.title, audio }];
        const text = readNodeTextInput(node);
        if (text) return [{ nodeId: node.id, type: "text" as const, title: node.title, text }];
        return [];
    });
}

export function buildNodeChatMessages(context: NodeGenerationContext): ChatCompletionMessage[] {
    if (!context.referenceImages.length) {
        return [{ role: "user", content: context.prompt }];
    }

    return [
        {
            role: "user",
            content: [{ type: "text" as const, text: context.prompt }, ...context.referenceImages.map((image) => ({ type: "image_url" as const, image_url: { url: image.dataUrl } }))],
        },
    ];
}

export async function hydrateNodeGenerationContext(context: NodeGenerationContext) {
    const hydrateImage = async (image: ReferenceImage) => {
        const url = image.url || (/^https?:\/\//i.test(image.dataUrl) ? image.dataUrl : undefined);
        return url ? { ...image, url } : { ...image, dataUrl: await imageToDataUrl(image) };
    };
    const { imageToDataUrl } = await import("@/services/image-storage");
    return {
        ...context,
        referenceImages: await Promise.all(context.referenceImages.map(hydrateImage)),
        firstFrame: context.firstFrame ? await hydrateImage(context.firstFrame) : null,
        lastFrame: context.lastFrame ? await hydrateImage(context.lastFrame) : null,
    };
}

function readNodeTextInput(node: CanvasNodeData) {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt || "";
    return node.metadata?.prompt || "";
}

function generationLabel(type: NodeGenerationInput["type"], index: number) {
    if (type === "image") return imageReferenceLabel(index);
    if (type === "video") return seedanceReferenceLabel("video", index);
    if (type === "audio") return seedanceReferenceLabel("audio", index);
    return `文本${index + 1}`;
}

function readReferenceImage(node: CanvasNodeData): ReferenceImage | null {
    if (!isCanvasImageNodeType(node.type) || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `image-${node.id}.png`,
        type: node.metadata.mimeType || "image/png",
        dataUrl: node.metadata.content,
        storageKey: node.metadata.storageKey,
    };
}

function readFrameReferences(node: CanvasNodeData | undefined, inputs: NodeGenerationInput[]) {
    const imageByNodeId = new Map(inputs.filter((input) => input.image).map((input) => [input.nodeId, input.image as ReferenceImage]));
    return {
        firstFrame: node?.metadata?.firstFrameNodeId ? imageByNodeId.get(node.metadata.firstFrameNodeId) || null : null,
        lastFrame: node?.metadata?.lastFrameNodeId ? imageByNodeId.get(node.metadata.lastFrameNodeId) || null : null,
    };
}

function readReferenceVideo(node: CanvasNodeData): ReferenceVideo | null {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `video-${node.id}.mp4`,
        type: node.metadata.mimeType || "video/mp4",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        bytes: node.metadata.bytes,
        width: node.metadata.naturalWidth,
        height: node.metadata.naturalHeight,
        durationMs: mediaDurationMs(node),
    };
}

function readReferenceAudio(node: CanvasNodeData): ReferenceAudio | null {
    if (node.type !== CanvasNodeType.Audio || !node.metadata?.content) return null;
    return {
        id: node.id,
        name: `audio-${node.id}.mp3`,
        type: node.metadata.mimeType || "audio/mpeg",
        url: node.metadata.content,
        storageKey: node.metadata.storageKey,
        durationMs: mediaDurationMs(node),
    };
}

/**
 * 片长先看 mediaDurationMs（真实片长）。没有时，画布生成的节点（有 startedAt）的 durationMs 记的是生成耗时，不当片长传，
 * 用到时由 fit/values.ts 读文件实测；上传的素材 durationMs 就是片长。
 */
function mediaDurationMs(node: CanvasNodeData) {
    return node.metadata?.mediaDurationMs ?? (node.metadata?.startedAt ? undefined : node.metadata?.durationMs);
}

/**
 * 出片后读一次真实片长，记在任务的 mediaDurationMs 上，随任务一起写进节点（和生成耗时 durationMs 分开）。
 * 没有成片地址、已经有片长时原样返回；读不出也原样返回，当参考素材时提交前再实测。
 */
export async function withMediaDuration<T extends { url?: string; video_url?: string; audio_url?: string; mediaDurationMs?: number }>(task: T, kind: "video" | "audio"): Promise<T> {
    const url = (kind === "video" ? task.video_url : task.audio_url) || task.url;
    if (!url || task.mediaDurationMs) return task;
    const { readMediaDurationMs } = await import("@/services/file-storage");
    const mediaDurationMs = await readMediaDurationMs(url, kind);
    return mediaDurationMs ? { ...task, mediaDurationMs } : task;
}
