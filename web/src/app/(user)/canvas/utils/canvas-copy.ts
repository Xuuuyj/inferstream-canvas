import { nanoid } from "nanoid";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";

/**
 * 右键「复制」生成出来的视频节点（提交时就有 videoTaskId）：副本只留提示词、参数（和 copiedConnections 带的素材连线），
 * 不带旧成片和任务号。空的视频节点点生成会直接在它里面出片，不会在旁边再新建一个。用户上传的视频没有 videoTaskId，照常整份复制。
 */
export function withoutGeneratedVideo(node: CanvasNodeData): CanvasNodeData {
    if (node.type !== CanvasNodeType.Video || !node.metadata?.videoTaskId) return node;
    return {
        ...node,
        metadata: {
            ...node.metadata,
            status: "idle",
            errorDetails: undefined,
            content: undefined,
            storageKey: "",
            progress: undefined,
            startedAt: undefined,
            durationMs: undefined,
            mediaDurationMs: undefined,
            naturalWidth: undefined,
            naturalHeight: undefined,
            mimeType: undefined,
            bytes: undefined,
            clientTaskId: undefined,
            videoTaskId: undefined,
            videoTaskVideoId: undefined,
            videoTaskTranslation: undefined,
            videoTaskFitKeyRef: undefined,
        },
    };
}

/**
 * 复制节点时要带上的连线。idMap 是原节点 id → 副本 id。
 * 副本之间的连线换到副本上；从副本外连进来的（参考素材、上游文本）也连到副本上，上游节点还在才连，
 * 这样复制后不用重新连素材就能再生成。批量出图根节点连向子图的线只表示归属，单独复制子图时不带。
 * 按原连线顺序返回，参考图的编号（图1、图2…）和原节点一致。
 */
export function copiedConnections(connections: CanvasConnection[], nodes: CanvasNodeData[], idMap: Map<string, string>): CanvasConnection[] {
    const upstream = new Set(nodes.filter((node) => !node.metadata?.isBatchRoot).map((node) => node.id));
    return connections.flatMap((connection) => {
        const toNodeId = idMap.get(connection.toNodeId);
        const fromNodeId = idMap.get(connection.fromNodeId) || (upstream.has(connection.fromNodeId) ? connection.fromNodeId : undefined);
        return toNodeId && fromNodeId ? [{ ...connection, id: nanoid(), fromNodeId, toNodeId }] : [];
    });
}
