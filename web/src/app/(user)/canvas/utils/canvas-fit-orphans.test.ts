import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CanvasNodeType, type CanvasNodeData } from "../types";
import { FIT_ORPHAN_GRACE_MS, adoptedFitVideoNode, orphanedFitVideos, type SubmittedFitVideo } from "./canvas-fit-orphans";

const video = (id: string, metadata: CanvasNodeData["metadata"], x = 0) => ({ id, type: CanvasNodeType.Video, title: id, position: { x, y: 10 }, width: 300, height: 200, metadata }) as CanvasNodeData;
const submitted = (entries: [string, SubmittedFitVideo][]) => new Map(entries);
const T0 = 1_000_000;
const late = T0 + FIT_ORPHAN_GRACE_MS;
// 提交返回时记下的节点：生成中、写上了 fit 任务号、还带着画布自己的 clientTaskId
const justSubmitted = (id: string, taskId: string) => video(id, { prompt: "新生报到", model: "seedance 2.5-GT", status: "loading", clientTaskId: "client_video_task_1", videoTaskId: taskId, videoTaskFitKeyRef: "t:1596", seconds: "30", groupId: "g1" });

test("节点在等、已出片或报错的任务不算没人跟；提交后 15 秒内也不算", () => {
    const tasks = submitted([["task_A", { at: T0, node: justSubmitted("A", "task_A") }], ["task_B", { at: T0, node: justSubmitted("B", "task_B") }], ["task_C", { at: T0, node: justSubmitted("C", "task_C") }]]);
    const nodes = [video("A", { status: "loading", videoTaskId: "task_A" }), video("B", { status: "success", videoTaskId: "task_B", content: "blob:b" }), video("C", { status: "error", videoTaskId: "task_C" })];
    assert.deepEqual(orphanedFitVideos(tasks, nodes, late), []);
    assert.deepEqual(orphanedFitVideos(tasks, [], late - 1), [], "刚提交、节点还没渲染出任务号");
});

test("节点换了任务（撤销、覆盖重生成）、停了或被删了，原任务就没人跟", () => {
    const tasks = submitted([["task_A", { at: T0, node: justSubmitted("A", "task_A") }], ["task_B", { at: T0, node: justSubmitted("B", "task_B") }], ["task_C", { at: T0, node: justSubmitted("C", "task_C") }]]);
    const nodes = [video("A", { status: "loading", videoTaskId: "task_A2" }), video("B", { status: "stopped", videoTaskId: "task_B" })];
    assert.deepEqual(orphanedFitVideos(tasks, nodes, late), ["task_A", "task_B", "task_C"]);
});

test("放回画布：原节点还在就放在它右边，不在就放回原位；新节点生成中、照原任务号轮询，不带 clientTaskId 和分组", () => {
    const entry = { at: T0, node: justSubmitted("A", "task_A") };
    const beside = adoptedFitVideoNode(entry, [video("A", { status: "idle" }, 100)], "video-2");
    assert.deepEqual(beside.position, { x: 100 + 300 + 48, y: 10 });
    assert.equal(beside.id, "video-2");
    assert.equal(beside.metadata?.status, "loading");
    assert.equal(beside.metadata?.videoTaskId, "task_A");
    assert.equal(beside.metadata?.videoTaskFitKeyRef, "t:1596", "轮询、下载要用提交时那把令牌");
    assert.equal(beside.metadata?.clientTaskId, undefined);
    assert.equal(beside.metadata?.groupId, undefined);
    assert.deepEqual([beside.metadata?.prompt, beside.metadata?.model, beside.metadata?.seconds], ["新生报到", "seedance 2.5-GT", "30"]);
    assert.deepEqual(adoptedFitVideoNode(entry, [], "video-3").position, { x: 0, y: 10 });
});

test("画布接线（bun 导入 tsx 太慢，按源码查）：fit 收下的视频不给停止；提交成功就记下，没人跟的放回画布；手动删生成中的视频先确认", () => {
    const panel = readFileSync(new URL("../components/canvas-node-prompt-panel.tsx", import.meta.url), "utf8");
    assert.match(panel, /const fitVideoRunning = node\.type === CanvasNodeType\.Video && !node\.metadata\?\.workflowRef && isFitConfig\(config\) && Boolean\(videoTaskId\) && !videoTaskId\.startsWith\("client_"\);/);
    assert.match(panel, /const canStop = !fitVideoRunning && /);
    const page = readFileSync(new URL("../[id]/canvas-client-page.tsx", import.meta.url), "utf8");
    assert.match(page, /if \(!workflowRef && isFitConfig\(videoGenerationConfig\) && videoTask\.id && !videoTask\.id\.startsWith\("client_"\) && nodesRef\.current\.some\(\(node\) => node\.id === videoId\)\) \{\n\s+submittedFitVideosRef\.current\.set\(videoTask\.id, /);
    assert.ok(page.indexOf("submittedFitVideosRef.current.set(videoTask.id") < page.indexOf("if (!isNodeTaskActive(videoId, clientTaskId)) return;"), "节点停了、换了任务也要先记下");
    assert.match(page, /const orphans = orphanedFitVideos\(submittedFitVideosRef\.current, nodesRef\.current, Date\.now\(\)\)/);
    assert.match(page, /removedNodes\.forEach\(\(node\) => \{ if \(node\.metadata\?\.videoTaskId\) submittedFitVideosRef\.current\.delete\(node\.metadata\.videoTaskId\); \}\);/);
    // 用户手动删（键盘、节点工具条、顶部工具栏、右键菜单）都先过 confirmDeleteNodes；只有助手的 delete_node 直接删
    assert.equal(page.match(/confirmDeleteNodes\(new Set\(/g)?.length, 4);
    assert.equal(page.match(/[^m]deleteNodes\(new Set\(/g)?.length, 1);
});
