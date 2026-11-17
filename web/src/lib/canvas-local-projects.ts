/**
 * 本机浏览器里有几个画布项目（读完本地存储再数）。用 openai.fit 静默登录画布之前要看它：登录后这些项目会同步进那个账号，没同步过的要先问用户。
 * 画布 store 很重，只在要用时动态加载（和 app/(user)/layout.tsx 一样）。
 */
export async function localCanvasProjectCount() {
    const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
    if (!useCanvasStore.getState().hydrated) {
        await new Promise<void>((resolve) => {
            const unsubscribe = useCanvasStore.subscribe((state) => {
                if (!state.hydrated) return;
                unsubscribe();
                resolve();
            });
            if (useCanvasStore.getState().hydrated) {
                unsubscribe();
                resolve();
            }
        });
    }
    return useCanvasStore.getState().projects.length;
}
