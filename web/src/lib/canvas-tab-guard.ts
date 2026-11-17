/**
 * 同一浏览器里同时开着几个画布页面时，只让最新打开的那个保存和清理。
 * 画布项目和素材都整份存在浏览器里，各页面互不知道对方改了什么：旧页面会把整份项目列表连同别的项目的旧版本写回去，
 * 清理时也会把别的页面刚加的素材当成没人用删掉（2026-11-11 有用户的素材就是这样没的）。
 * 新的画布页面一打开就广播一声；旧页面收到后停止保存、停止清理，并提示用户关掉它或刷新。
 */
const CHANNEL = "infinite-canvas-tabs";
const tabId = Math.random().toString(36).slice(2);
let superseded = false;
let channel: BroadcastChannel | null = null;
const listeners = new Set<() => void>();

export function isCanvasTabSuperseded() {
    return superseded;
}

/** 这个页面打开了画布：通知别的画布页面停下。返回取消订阅函数；onSuperseded 在本页被更新的页面取代时调用。 */
export function announceCanvasTab(onSuperseded: () => void) {
    listeners.add(onSuperseded);
    if (!channel && typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(CHANNEL);
        channel.onmessage = (event: MessageEvent<{ type?: string; tabId?: string }>) => {
            if (event.data?.type !== "open" || event.data.tabId === tabId || superseded) return;
            superseded = true;
            listeners.forEach((listener) => listener());
        };
    }
    channel?.postMessage({ type: "open", tabId });
    return () => {
        listeners.delete(onSuperseded);
    };
}
