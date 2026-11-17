import assert from "node:assert/strict";
import test from "node:test";
import { RECOVERY_RETRY_MS, freshRecoveryFailures } from "./canvas-video-recovery";

test("取不回来的成片 24 小时内不再重试，过了 24 小时的记录删掉", () => {
    const now = 10 * RECOVERY_RETRY_MS;
    const failures = { task_recent: now - 1000, task_old: now - RECOVERY_RETRY_MS, task_bad: Number.NaN as unknown as number };
    assert.deepEqual(freshRecoveryFailures(failures, now), { task_recent: now - 1000 }, "坏记录也丢掉");
});
