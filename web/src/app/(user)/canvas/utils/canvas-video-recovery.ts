/**
 * 打开画布时从 openai.fit 取回本地丢了的成片（canvas-client-page 里的取回）：取不回来的记下来，24 小时内不再重试；
 * 连续失败几条就停，多半是浏览器空间不够或成片已过保存期，不能每次打开画布都把几个 GB 重新下一遍。
 * 记录很小（只有失败的任务号和时间，超过 24 小时的删掉），放 localStorage；读写失败当作没有记录。
 */
export const RECOVERY_RETRY_MS = 24 * 60 * 60 * 1000;
export const RECOVERY_MAX_CONSECUTIVE_FAILURES = 3;
const FAILURES_KEY = "infinite-canvas:video-recovery-failed";

/** 去掉超过 24 小时的失败记录。 */
export function freshRecoveryFailures(failures: Record<string, number>, now: number) {
    return Object.fromEntries(Object.entries(failures).filter(([, at]) => typeof at === "number" && now - at < RECOVERY_RETRY_MS));
}

export function readRecoveryFailures(now = Date.now()): Record<string, number> {
    try {
        return freshRecoveryFailures(JSON.parse(window.localStorage.getItem(FAILURES_KEY) || "{}") as Record<string, number>, now);
    } catch {
        return {};
    }
}

export function writeRecoveryFailures(failures: Record<string, number>) {
    try {
        window.localStorage.setItem(FAILURES_KEY, JSON.stringify(failures));
    } catch {
        // 存不了就下次再试
    }
}
