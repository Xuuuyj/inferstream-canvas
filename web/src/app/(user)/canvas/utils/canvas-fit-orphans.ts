import { CanvasNodeType, type CanvasNodeData } from "../types";

/** 本页提交成功的 openai.fit 视频任务：提交时间，和刚写上任务号的节点（任务号、令牌、参数都在里面）。 */
export type SubmittedFitVideo = { at: number; node: CanvasNodeData };

/** 提交返回到节点写上任务号之间隔着一次渲染，这段时间不算没人跟。 */
export const FIT_ORPHAN_GRACE_MS = 15_000;

/**
 * openai.fit 没有取消接口，提交成功就扣费。节点被撤销、覆盖、换了任务以后，这条任务就没有节点在查了，成片出来也看不到
 * （用户 2026-11-11：点一次生成扣了两次费，第一条成片不在画布上）。返回这种没人跟的任务号：
 * 画布上没有哪个视频节点在等它（生成中）、已经出了它的片或报了它的错。
 */
export function orphanedFitVideos(submitted: Map<string, SubmittedFitVideo>, nodes: CanvasNodeData[], now: number) {
    const followed = new Set(nodes.flatMap((node) => node.type === CanvasNodeType.Video && node.metadata?.videoTaskId && (node.metadata.status === "loading" || node.metadata.status === "error" || node.metadata.content) ? [node.metadata.videoTaskId] : []));
    return [...submitted].filter(([taskId, entry]) => now - entry.at >= FIT_ORPHAN_GRACE_MS && !followed.has(taskId)).map(([taskId]) => taskId);
}

/** 没人跟的任务放回画布：在提交它的节点右边（那个节点已经不在就放回原位）新建一个生成中的视频节点，画布照常轮询、出片。 */
export function adoptedFitVideoNode(entry: SubmittedFitVideo, nodes: CanvasNodeData[], id: string): CanvasNodeData {
    const origin = nodes.find((node) => node.id === entry.node.id);
    return {
        ...entry.node,
        id,
        position: origin ? { x: origin.position.x + origin.width + 48, y: origin.position.y } : entry.node.position,
        metadata: { ...entry.node.metadata, status: "loading", content: undefined, storageKey: "", errorDetails: undefined, clientTaskId: undefined, taskBackend: undefined, groupId: undefined },
    };
}
