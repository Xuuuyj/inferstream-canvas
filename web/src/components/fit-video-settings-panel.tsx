"use client";

import { type ReactNode } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Slider, Switch } from "antd";

import { useFitProfile } from "@/hooks/use-fit-profile";
import { type CanvasTheme } from "@/lib/canvas-theme";
import type { AdvancedValues } from "@/lib/fit-generate/types";
import { fitAdvancedPatch, fitPanel, type FitPanelKey } from "@/lib/fit-panel";
import { canvasToFitValues } from "@/services/api/fit/values";
import { fitKeyFor } from "@/lib/fit-config";
import { useConfigStore, type AiConfig } from "@/stores/use-config-store";

/** 调用方都把 (key, value) 原样写进画布配置或节点 metadata；fitAdvanced 写的是对象。 */
export type FitConfigChange = (key: FitPanelKey, value: string | AdvancedValues) => void;

/** 这个模型的 fit 卡片，以及按当前设置真正会发出去的表单值（canvasToFitValues，不带参考素材、不读文件）。 */
export function useFitPanel(model: string | undefined, config: AiConfig) {
    const profile = useFitProfile(model);
    const { data } = useQuery({
        queryKey: ["fit-panel-values", profile?.modelName, config.videoSeconds, config.vquality, config.size, config.quality, config.fitAdvanced],
        queryFn: async () => ({ model: profile!.modelName, values: await canvasToFitValues(profile!, config, "") }),
        enabled: Boolean(profile),
        placeholderData: keepPreviousData,
    });
    return { profile, values: profile && data?.model === profile.modelName ? data.values : null };
}

type FitSettingsPanelProps = {
    kind: "image" | "video";
    config: AiConfig;
    model: string;
    theme: CanvasTheme;
    onConfigChange: FitConfigChange;
    showTitle?: boolean;
    className?: string;
    visualOnly?: boolean;
    showSize?: boolean;
    showCount?: boolean;
    maxCount?: number;
    quickCount?: number;
};

/** openai.fit 卡片的参数面板：时长、清晰度、画幅/尺寸、客户可选的高级参数和素材上限，全部按 fit 生成台的 profile 渲染。 */
export function FitSettingsPanel({
    kind,
    config,
    model,
    theme,
    onConfigChange,
    showTitle = true,
    className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5",
    visualOnly = false,
    showSize = true,
    showCount = false,
    maxCount = 15,
    quickCount = 10,
}: FitSettingsPanelProps) {
    const hasToken = Boolean(useConfigStore((state) => fitKeyFor(state.config, kind)));
    const { profile, values } = useFitPanel(model, config);
    const panel = profile && values ? fitPanel(profile, values, { visualOnly, showSize }) : null;
    const count = Math.max(1, Math.min(maxCount, Math.floor(Math.abs(Number(config.count)) || 1)));
    const setAdvanced = (key: string, value: boolean | string) => profile && onConfigChange("fitAdvanced", fitAdvancedPatch(profile, config.fitAdvanced, key, value));

    return (
        <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
            {showTitle ? <div className="text-lg font-semibold">{kind === "image" ? "图像设置" : "视频设置"}</div> : null}
            {!panel ? (
                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                    {hasToken ? "正在读取模型参数；一直没有的话，说明当前令牌不能用这个模型，请换一个。" : `配置可用的${kind === "image" ? "图片" : "视频"}令牌后，这里显示该模型可选的参数。`}
                </div>
            ) : null}
            {panel?.seconds ? (
                <Group title="时长" theme={theme}>
                    {panel.seconds.mode === "fixed" ? (
                        <div className="text-sm">固定 {panel.seconds.value} 秒</div>
                    ) : panel.seconds.mode === "steps" ? (
                        <Pills
                            options={panel.seconds.options.map((value) => ({ value: String(value), label: `${value} 秒`, write: String(value) }))}
                            value={String(panel.seconds.value)}
                            theme={theme}
                            onChange={(value) => onConfigChange("videoSeconds", value)}
                        />
                    ) : (
                        <div className="grid grid-cols-[minmax(0,1fr)_56px] items-center gap-3">
                            <Slider min={panel.seconds.min} max={panel.seconds.max} step={1} value={panel.seconds.value} tooltip={{ zIndex: 1300 }} onChange={(value) => onConfigChange("videoSeconds", String(value))} />
                            <span className="text-right text-sm tabular-nums">{panel.seconds.value} 秒</span>
                        </div>
                    )}
                </Group>
            ) : null}
            {panel?.groups.map((group) => (
                <Group key={group.title} title={group.title} theme={theme}>
                    <Pills options={group.options} value={group.value} theme={theme} onChange={(value) => onConfigChange(group.key, value)} />
                </Group>
            ))}
            {panel?.advanced.length ? (
                <Group title="高级参数" theme={theme}>
                    {panel.advanced.map((control) =>
                        control.param.kind === "boolean" ? (
                            <div key={control.param.key} className="flex h-8 items-center justify-between gap-3 text-sm">
                                <span>{control.label}</span>
                                <span onMouseDown={(event) => event.stopPropagation()}>
                                    <Switch size="small" checked={control.value === true} onChange={(checked) => setAdvanced(control.param.key, checked)} />
                                </span>
                            </div>
                        ) : (
                            <div key={control.param.key} className="space-y-1.5">
                                <div className="text-sm">{control.label}</div>
                                <Pills options={control.options} value={typeof control.value === "string" ? control.value : null} theme={theme} onChange={(value) => setAdvanced(control.param.key, value)} />
                            </div>
                        ),
                    )}
                </Group>
            ) : null}
            {showCount && kind === "image" ? (
                <Group title="生成张数" theme={theme}>
                    <div className="grid grid-cols-4 gap-2.5">
                        {Array.from({ length: quickCount }, (_, index) => index + 1).map((value) => (
                            <Pill key={value} selected={count === value} theme={theme} onClick={() => onConfigChange("count", String(value))}>
                                {value} 张
                            </Pill>
                        ))}
                        <input
                            type="number"
                            min={1}
                            max={maxCount}
                            className="col-span-2 h-9 rounded-full border bg-transparent px-3 text-center text-sm outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                            style={{ borderColor: theme.node.stroke, color: theme.node.text, WebkitTextFillColor: theme.node.text }}
                            value={count}
                            onChange={(event) => onConfigChange("count", String(Number(event.target.value) || 1))}
                            onMouseDown={(event) => event.stopPropagation()}
                        />
                    </div>
                </Group>
            ) : null}
            {panel?.references ? (
                <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                    {panel.references}
                </div>
            ) : null}
            {panel?.hint ? (
                <div className="text-[11px] leading-4" style={{ color: theme.node.muted }}>
                    {panel.hint}
                </div>
            ) : null}
        </div>
    );
}

function Group({ title, theme, children }: { title: string; theme: CanvasTheme; children: ReactNode }) {
    return (
        <div className="space-y-2.5">
            <div className="text-xs font-medium" style={{ color: theme.node.muted }}>
                {title}
            </div>
            {children}
        </div>
    );
}

function Pills({ options, value, theme, onChange }: { options: Array<{ value: string; label: string; write: string }>; value: string | null; theme: CanvasTheme; onChange: (write: string) => void }) {
    return (
        <div className={`grid gap-2.5 ${options.some((option) => option.label.length > 8) ? "grid-cols-2" : "grid-cols-3"}`}>
            {options.map((option) => (
                <Pill key={option.value} selected={option.value === value} theme={theme} onClick={() => onChange(option.write)}>
                    {option.label}
                </Pill>
            ))}
        </div>
    );
}

function Pill({ selected, theme, onClick, children }: { selected: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            className="min-h-9 cursor-pointer rounded-full border px-2 text-sm leading-4 transition hover:opacity-80"
            style={{ background: "transparent", borderColor: selected ? theme.node.text : theme.node.stroke, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}
