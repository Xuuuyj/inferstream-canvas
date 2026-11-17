import assert from "node:assert/strict";
import test from "node:test";
import { announceCanvasTab, isCanvasTabSuperseded } from "./canvas-tab-guard";

test("另一个画布页面打开后，本页标记为被取代并通知界面；自己的广播不算", async () => {
    let notified = 0;
    const stop = announceCanvasTab(() => notified++);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(isCanvasTabSuperseded(), false, "只有自己时不停");

    const other = new BroadcastChannel("infinite-canvas-tabs");
    other.postMessage({ type: "open", tabId: "another-tab" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    other.close();
    stop();
    assert.equal(isCanvasTabSuperseded(), true);
    assert.equal(notified, 1);
});
