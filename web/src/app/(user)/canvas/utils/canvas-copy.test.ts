import assert from "node:assert/strict";
import test from "node:test";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "../types";
import { copiedConnections, withoutGeneratedVideo } from "./canvas-copy";

const node = (id: string, type = CanvasNodeType.Image, metadata?: CanvasNodeData["metadata"]) => ({ id, type, title: id, position: { x: 0, y: 0 }, width: 100, height: 100, metadata }) as CanvasNodeData;
const wire = (fromNodeId: string, toNodeId: string): CanvasConnection => ({ id: `${fromNodeId}-${toNodeId}`, fromNodeId, toNodeId });
const ends = (connections: CanvasConnection[]) => connections.map((connection) => `${connection.fromNodeId}>${connection.toNodeId}`);

test("复制视频节点：参考图、参考视频、音频按原顺序连到副本，下游连线不带", () => {
    const nodes = [node("img1"), node("img2"), node("clip", CanvasNodeType.Video), node("voice", CanvasNodeType.Audio), node("V", CanvasNodeType.Video), node("next", CanvasNodeType.Video)];
    const connections = [wire("img2", "V"), wire("img1", "V"), wire("clip", "V"), wire("voice", "V"), wire("V", "next"), wire("img1", "next")];
    const copied = copiedConnections(connections, nodes, new Map([["V", "V2"]]));
    assert.deepEqual(ends(copied), ["img2>V2", "img1>V2", "clip>V2", "voice>V2"]);
    assert.ok(copied.every((connection) => !connections.some((original) => original.id === connection.id)), "副本连线要用新 id");
});

test("粘贴多个节点：内部连线换到副本，外部上游照样连，已删的上游不连", () => {
    const nodes = [node("img1"), node("T", CanvasNodeType.Text), node("V", CanvasNodeType.Video)];
    const connections = [wire("img1", "V"), wire("T", "V"), wire("gone", "V")];
    assert.deepEqual(ends(copiedConnections(connections, nodes, new Map([["T", "T2"], ["V", "V2"]]))), ["img1>V2", "T2>V2"]);
});

test("单独复制批量出图的子图不带归属线，连根一起复制时照样带", () => {
    const nodes = [node("src"), node("root", CanvasNodeType.Image, { isBatchRoot: true }), node("child", CanvasNodeType.Image, { batchRootId: "root" })];
    const connections = [wire("src", "root"), wire("root", "child")];
    assert.deepEqual(ends(copiedConnections(connections, nodes, new Map([["child", "child2"]]))), []);
    assert.deepEqual(ends(copiedConnections(connections, nodes, new Map([["root", "root2"], ["child", "child2"]]))), ["src>root2", "root2>child2"]);
});

test("复制生成出来的视频节点：去掉旧成片和任务号，提示词和参数留着；上传的视频、图片整份复制", () => {
    const generated = node("V", CanvasNodeType.Video, { prompt: "新生报到", model: "seedance", seconds: "4", size: "720x1280", status: "success", content: "https://x/v.mp4", storageKey: "k", videoTaskId: "task_1", videoTaskFitKeyRef: "t:9", naturalWidth: 720, naturalHeight: 1280 });
    const copy = withoutGeneratedVideo(generated);
    assert.equal(copy.metadata?.content, undefined);
    assert.equal(copy.metadata?.videoTaskId, undefined);
    assert.equal(copy.metadata?.status, "idle");
    assert.deepEqual([copy.metadata?.prompt, copy.metadata?.model, copy.metadata?.seconds, copy.metadata?.size], ["新生报到", "seedance", "4", "720x1280"]);
    assert.equal(generated.metadata?.content, "https://x/v.mp4", "原节点不动");
    const uploaded = node("U", CanvasNodeType.Video, { content: "blob:clip", status: "success" });
    const image = node("I", CanvasNodeType.Image, { content: "https://x/a.png", imageTaskId: "img_1" });
    assert.equal(withoutGeneratedVideo(uploaded), uploaded);
    assert.equal(withoutGeneratedVideo(image), image);
});
