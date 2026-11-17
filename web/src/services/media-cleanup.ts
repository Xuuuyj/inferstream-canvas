import localforage from "localforage";

/** 判定没人用的本地素材先记下，过了这么久、再次判定还是没人用才真删（给另一个页面刚加、还没存盘的素材留余地）。 */
export const CLEANUP_GRACE_MS = 30 * 60 * 1000;

const pendingStore = localforage.createInstance({ name: "infinite-canvas", storeName: "cleanup_pending" });

/**
 * since：上次记下的「键 → 第一次判定没人用的时间」。返回这次可以删的键，和要记下的新表：
 * 这次没人用、第一次见的记下当前时间；记下满 CLEANUP_GRACE_MS 的放进 ready；这次又有人用的（不在 unused 里）从表里去掉。
 */
export function settleCleanup(since: Record<string, number>, unused: Iterable<string>, now: number) {
    const ready: string[] = [];
    const pending: Record<string, number> = {};
    for (const key of new Set(unused)) {
        const first = since[key];
        if (first === undefined) pending[key] = now;
        else if (now - first >= CLEANUP_GRACE_MS) ready.push(key);
        else pending[key] = first;
    }
    return { ready, pending };
}

/** scope 区分图片、音视频两套清理，各记各的。读写记录出错时一个都不删。 */
export async function keysReadyToDelete(scope: "image" | "media", unused: Iterable<string>, now = Date.now()) {
    try {
        const since = (await pendingStore.getItem<Record<string, number>>(scope)) || {};
        const { ready, pending } = settleCleanup(since, unused, now);
        await pendingStore.setItem(scope, pending);
        return ready;
    } catch {
        return [];
    }
}
