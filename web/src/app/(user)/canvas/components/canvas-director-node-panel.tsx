"use client";

import { Layers3 } from "lucide-react";

import { DIRECTOR_ENABLED } from "@/constant/features";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasDirectorNodePanel({ onOpen }: { onOpen: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-6 px-8 text-center" style={{ color: theme.node.text }}>
            <Layers3 className="size-11" strokeWidth={1.8} style={{ color: theme.node.muted }} />
            <p className="m-0 text-[17px] font-medium leading-7" style={{ color: theme.node.placeholder }}>{DIRECTOR_ENABLED ? "在3D空间中搭建场景并进行多视角截图" : "3D 导演台暂未开放"}</p>
            {/* 导演台关着时（导入的旧项目里可能还有这种节点）只显示说明，不给打开 */}
            {DIRECTOR_ENABLED ? (
                <button
                    type="button"
                    className="rounded-xl border px-6 py-2 text-lg font-medium transition"
                    style={{ background: theme.toolbar.itemHover, borderColor: theme.node.stroke, color: theme.node.text }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        onOpen();
                    }}
                >
                    打开导演台
                </button>
            ) : null}
        </div>
    );
}