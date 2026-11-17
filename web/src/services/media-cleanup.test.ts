import assert from "node:assert/strict";
import test from "node:test";
import { CLEANUP_GRACE_MS, settleCleanup } from "./media-cleanup";

test("没人用的素材先记下不删；满 30 分钟再判定还是没人用才删；中途又有人用的从记录里去掉", () => {
    const first = settleCleanup({}, ["image:a", "image:b"], 1000);
    assert.deepEqual(first, { ready: [], pending: { "image:a": 1000, "image:b": 1000 } });

    const early = settleCleanup(first.pending, ["image:a", "image:b"], 1000 + CLEANUP_GRACE_MS - 1);
    assert.deepEqual(early.ready, [], "不到 30 分钟一个都不删");

    // image:b 被另一个页面用上了（这次不在没人用的名单里）
    const later = settleCleanup(early.pending, ["image:a", "image:c"], 1000 + CLEANUP_GRACE_MS);
    assert.deepEqual(later.ready, ["image:a"]);
    assert.deepEqual(later.pending, { "image:c": 1000 + CLEANUP_GRACE_MS });
});

test("已存盘的项目里用到的素材也算有人用（另一个页面刚加的素材在这里能看到）", async () => {
    const { collectMediaStorageKeys } = await import("./file-storage");
    const { collectImageStorageKeys } = await import("./image-storage");
    const savedOnDisk = JSON.parse(JSON.stringify({
        state: { projects: [{ id: "p2", nodes: [{ id: "n1", metadata: { storageKey: "video:new" } }, { id: "n2", metadata: { storageKey: "image:new", content: "blob:x" } }] }] },
        version: 0,
    }));
    const usedData = { projects: [{ id: "p2", nodes: [] }], saved: [savedOnDisk, null] };
    assert.ok(collectMediaStorageKeys(usedData).has("video:new"));
    assert.ok(collectImageStorageKeys(usedData).has("image:new"));
});
