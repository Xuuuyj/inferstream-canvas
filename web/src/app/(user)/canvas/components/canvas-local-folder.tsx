"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button } from "antd";
import { FolderCheck, FolderOpen, FolderSync, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { backfillLocalFolder, chooseLocalFolder, localFolderState, reauthorizeLocalFolder, type LocalFolderState } from "@/services/local-folder";
import { useThemeStore } from "@/stores/use-theme-store";

/** 用户点过「不再提示」就不再建议设置文件夹（极小的界面偏好，放 localStorage）。 */
const DISMISS_KEY = "infinite-canvas:local-folder-tip-dismissed";

function useLocalFolder() {
    const { message } = App.useApp();
    const [state, setState] = useState<LocalFolderState | null>(null);
    const refresh = useCallback(() => localFolderState().then(setState).catch(() => setState(null)), []);

    useEffect(() => {
        void refresh();
        window.addEventListener("focus", refresh);
        return () => window.removeEventListener("focus", refresh);
    }, [refresh]);

    /** 选好或重新授权后，把浏览器里已有的素材补存一份到文件夹。 */
    const backfill = useCallback(async () => {
        const key = "local-folder-backfill";
        message.loading({ key, content: "正在把已有素材存到本地文件夹…", duration: 0 });
        try {
            const written = await backfillLocalFolder((done, total) => message.loading({ key, content: `正在把已有素材存到本地文件夹（${done}/${total}）…`, duration: 0 }));
            message.success({ key, content: written ? `已把 ${written} 个素材存到本地文件夹，以后生成的也会自动存一份` : "本地文件夹已设置好，以后生成的素材会自动存一份" });
        } catch {
            message.error({ key, content: "存到本地文件夹失败，请换一个有写入权限的文件夹再试" });
        }
    }, [message]);

    const choose = useCallback(async () => {
        try {
            if (!(await chooseLocalFolder())) return;
        } catch {
            message.error("没能打开这个文件夹，请换一个文件夹（不要选系统文件夹或整个磁盘）");
            return;
        }
        await refresh();
        await backfill();
    }, [backfill, message, refresh]);

    const reauthorize = useCallback(async () => {
        if (!(await reauthorizeLocalFolder().catch(() => false))) {
            message.warning("没有授权，新素材暂时不会存到本地文件夹");
            return;
        }
        await refresh();
        await backfill();
    }, [backfill, message, refresh]);

    return { state, choose, reauthorize };
}

/** 画布列表页：设置 / 更换本地素材文件夹。浏览器不支持时不显示。 */
export function CanvasLocalFolderButton({ disabled }: { disabled?: boolean }) {
    const { state, choose, reauthorize } = useLocalFolder();
    if (!state?.supported) return null;
    if (!state.name) {
        return (
            <Button disabled={disabled} icon={<FolderOpen className="size-4" />} onClick={() => void choose()} title="生成的视频、上传的素材同时存一份到你电脑上的文件夹，清浏览器缓存也不会丢">
                设置本地素材文件夹
            </Button>
        );
    }
    if (state.permission !== "granted") {
        return (
            <Button disabled={disabled} icon={<FolderSync className="size-4" />} onClick={() => void reauthorize()} title={`本地素材文件夹「${state.name}」需要重新授权`}>
                授权本地文件夹「{state.name}」
            </Button>
        );
    }
    return (
        <Button disabled={disabled} icon={<FolderCheck className="size-4" />} onClick={() => void choose()} title="点击更换文件夹">
            素材存到「{state.name}」
        </Button>
    );
}

/** 画布页：文件夹要重新授权时提示；支持但还没设置时建议一次（可不再提示）。 */
export function CanvasLocalFolderNotice() {
    const theme = canvasThemes[useThemeStore((current) => current.theme)];
    const { state, choose, reauthorize } = useLocalFolder();
    const [dismissed, setDismissed] = useState(true);

    useEffect(() => {
        try {
            setDismissed(window.localStorage.getItem(DISMISS_KEY) === "1");
        } catch {
            setDismissed(false);
        }
    }, []);

    if (!state?.supported) return null;
    const needsGrant = Boolean(state.name) && state.permission !== "granted";
    if (!needsGrant && (state.name || dismissed)) return null;

    const dismiss = () => {
        setDismissed(true);
        try {
            window.localStorage.setItem(DISMISS_KEY, "1");
        } catch {
            // 存不了就只在这一页不再显示
        }
    };

    return (
        <div
            className="pointer-events-auto fixed left-1/2 top-16 z-[70] flex max-w-[92vw] -translate-x-1/2 items-center gap-3 rounded-xl border px-3 py-2 text-xs shadow-lg"
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
        >
            <span className="leading-5">
                {needsGrant
                    ? `本地素材文件夹「${state.name}」需要重新授权，授权前新素材不会存到电脑上`
                    : "建议设置本地素材文件夹：生成的视频、上传的素材会同时存到你电脑上，清浏览器缓存也不会丢"}
            </span>
            <Button size="small" type="primary" onClick={() => void (needsGrant ? reauthorize() : choose())}>
                {needsGrant ? "授权" : "选择文件夹"}
            </Button>
            {needsGrant ? null : (
                <button type="button" className="opacity-60 hover:opacity-100" onClick={dismiss} title="不再提示">
                    <X className="size-4" />
                </button>
            )}
        </div>
    );
}
