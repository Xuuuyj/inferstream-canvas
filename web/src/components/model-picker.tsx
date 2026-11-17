"use client";

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { Cpu } from "lucide-react";

import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { useAutoDLWorkflowNames } from "@/hooks/use-autodl-workflow";
import { useFitPricing } from "@/hooks/use-fit-pricing";
import { useFitProfile } from "@/hooks/use-fit-profile";
import { ModelPriceHint } from "@/lib/fit-generate/components/model-price-hint";
import { fitTokenPriceText, type FitPricing } from "@/lib/fit-price";
import { inferStreamImageModel } from "@/lib/inferstream-image-access";
import { FIT_CHANNEL_ID, isWorkflowProtocol } from "@/lib/model-channel";
import { cn } from "@/lib/utils";
import type { WorkflowRef } from "@/lib/workflow-channel";
import { fitKeyFor, hasAnyFitKey, missingFitKeyMessage } from "@/lib/fit-config";
import { fitPriceSelection } from "@/services/api/fit/values";
import { filterModelsByCapability, normalizeLocalChannels, useConfigStore, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelPickerProps = {
    config: AiConfig;
    value?: string;
    channelId?: string;
    capability?: ModelCapability;
    onChange: (model: string, channelId?: string) => void;
    workflowRef?: WorkflowRef;
    onWorkflowChange?: (ref?: WorkflowRef) => void;
    className?: string;
    fullWidth?: boolean;
    placeholder?: string;
    onMissingConfig?: () => void;
};

type PickerBase = { key: string; channelId?: string; channelName: string; protocol?: string; baseUrl?: string };
type PickerOption = (PickerBase & { model: string }) | (PickerBase & { model: ""; workflowRef: WorkflowRef; label: string });

export function ModelPicker({ config, value, channelId, capability, onChange, workflowRef, onWorkflowChange, className, fullWidth = false, placeholder = "选择模型", onMissingConfig }: ModelPickerProps) {
    const pickerId = useId();
    const [open, setOpen] = useState(false);
    const token = useUserStore((state) => state.token);
    const userReady = useUserStore((state) => state.isReady);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const inferStreamImages = capability === "image" && publicSettings?.auth?.inferStreamLogin === true;
    const workflowEnabled = Boolean(onWorkflowChange && capability && capability !== "text");
    // 这类模型用哪把令牌：语音跟文本走同一把；没指定类型时有任何一把就算有
    const keyKind = capability === "audio" ? "text" : capability;
    const hasFitToken = Boolean(keyKind ? fitKeyFor(config, keyKind) : hasAnyFitKey(config));
    const channelOptions = useMemo<PickerOption[]>(() => {
        const channels =
            config.channelMode === "remote"
                ? config.publicChannels.map((channel) => ({ id: channel.id, protocol: channel.protocol, name: channel.id === FIT_CHANNEL_ID ? "旧模型服务" : channel.name || "云端渠道", baseUrl: channel.baseUrl, models: channel.models, modelCapabilities: channel.modelCapabilities, workflows: channel.workflows || [] }))
                : normalizeLocalChannels(config).map((channel) => ({ id: channel.id, protocol: channel.protocol, name: channel.id === FIT_CHANNEL_ID ? "旧模型服务" : channel.name || "本地渠道", baseUrl: channel.baseUrl, models: channel.models, modelCapabilities: channel.modelCapabilities, workflows: channel.workflowSummaries || [] }));
        const filtered = inferStreamImages ? [{ key: inferStreamImageModel, channelName: "InferStream", model: inferStreamImageModel }] : channels.filter((channel) => !isWorkflowProtocol(channel.protocol || "")).flatMap((channel) => filterModelsByCapability(channel.models ?? [], capability, channel.protocol || "", channel.modelCapabilities).map((model) => ({ key: `${channel.id}::${model}`, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, model })));
        if (!workflowEnabled || !token) return filtered;
        const scope = config.channelMode === "remote" ? "system" : "personal";
        return [...filtered, ...channels.flatMap((channel) => isWorkflowProtocol(channel.protocol || "") ? channel.workflows.filter((entry) => entry.enabled && entry.capability === capability && entry.provider === channel.protocol).map((entry) => {
            const ref: WorkflowRef = { scope, channelId: channel.id || "", kind: entry.kind, workflowId: entry.workflowId };
            return { key: `workflow:${JSON.stringify([ref.scope, ref.channelId, ref.kind, ref.workflowId])}`, channelId: channel.id, channelName: channel.name, protocol: channel.protocol, baseUrl: channel.baseUrl, model: "", workflowRef: ref, label: entry.title || entry.workflowId };
        }) : [])];
    }, [capability, config, inferStreamImages, token, workflowEnabled]);
    const modelLabel = useAutoDLWorkflowNames(channelOptions);
    const currentOption = useMemo<PickerOption | undefined>(() => {
        if (workflowRef && workflowEnabled) return channelOptions.find((item) => "workflowRef" in item && item.key === `workflow:${JSON.stringify([workflowRef.scope, workflowRef.channelId, workflowRef.kind, workflowRef.workflowId])}`);
        if (!value) return undefined;
        return channelOptions.find((item) => item.model === value && item.channelId === channelId) || channelOptions.find((item) => item.model === value);
    }, [channelId, channelOptions, value, workflowEnabled, workflowRef]);
    const options = channelOptions;
    const current = workflowRef && workflowEnabled ? (currentOption && "label" in currentOption ? currentOption.label : "") : value || "";
    const currentValue = current && currentOption ? currentOption.key : "";
    // openai.fit 渠道的模型显示价格；选中的模型和 fit 生成台一样按当前清晰度、时长估价
    const pricing = useFitPricing(channelOptions.some((item) => fitModelOf(item)));
    const selectedFitModel = current ? fitModelOf(currentOption) : "";
    const selectedProfile = useFitProfile(pricing?.models.has(selectedFitModel) ? selectedFitModel : undefined);
    const selectedPrice = pricing?.models.has(selectedFitModel) ? (
        <FitPrice pricing={pricing} model={selectedFitModel} selection={selectedProfile ? fitPriceSelection(selectedProfile, config) : undefined} className="truncate text-[10px] leading-3" />
    ) : null;
    const triggerText = workflowRef && workflowEnabled ? current || "工作流已停用、未公开或删除，请重新选择" : modelLabel(current, currentOption) || placeholder;

	useEffect(() => {
		if (workflowRef && workflowEnabled) {
			const workflowOptionsReady = workflowRef.scope === "system"
				? publicSettings !== null
				: config.workflowSyncTouched === true;
			if (token && userReady && workflowOptionsReady && !currentOption && channelOptions.some((item) => !("workflowRef" in item))) {
				onWorkflowChange?.(undefined);
            }
            return;
        }
        if (value && currentOption?.channelId && !("workflowRef" in currentOption) && channelId !== currentOption.channelId) onChange(value, currentOption.channelId);
	}, [channelId, channelOptions, config.workflowSyncTouched, currentOption, onChange, onWorkflowChange, publicSettings, token, userReady, value, workflowEnabled, workflowRef]);

    useEffect(() => {
        const closeOtherPicker = (event: Event) => {
            if ((event as CustomEvent<string>).detail !== pickerId) setOpen(false);
        };
        window.addEventListener("model-picker-open", closeOtherPicker);
        return () => window.removeEventListener("model-picker-open", closeOtherPicker);
    }, [pickerId]);

    return (
        <Select
            open={open}
            value={current ? currentValue : ""}
            onOpenChange={(nextOpen) => {
                // 没填令牌才去配置；有令牌但这一类没有模型时照常展开，告诉用户 openai.fit 暂无这类模型。
                if (nextOpen && !inferStreamImages && !hasFitToken && onMissingConfig) {
                    onMissingConfig();
                    return;
                }
                if (nextOpen) window.dispatchEvent(new CustomEvent("model-picker-open", { detail: pickerId }));
                setOpen(nextOpen);
            }}
            onValueChange={(nextValue) => {
                const option = options.find((item) => item.key === nextValue);
                if (!option) return;
                if ("workflowRef" in option) onWorkflowChange?.(option.workflowRef);
                else { onChange(option.model, option.channelId); if (workflowRef) onWorkflowChange?.(undefined); }
            }}
        >
            <SelectTrigger
                className={cn(
                    "canvas-composer-model-picker h-8 w-fit max-w-full gap-2 rounded-full border border-input bg-transparent px-3 text-sm font-normal shadow-sm transition-colors",
                    fullWidth ? "w-full min-w-0 justify-start" : "min-w-[9rem] justify-start",
                    "data-[state=open]:border-ring data-[state=open]:ring-2 data-[state=open]:ring-ring/20",
                    selectedPrice && "py-0.5",
                    className,
                )}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={workflowRef && workflowEnabled && !currentOption ? "工作流已停用、未公开或删除，请重新选择" : current || placeholder}
            >
                <ModelIcon model={current} />
                {selectedPrice ? (
                    <span className="canvas-model-picker-text flex min-w-0 flex-1 flex-col text-left leading-4">
                        <span className="truncate">{triggerText}</span>
                        {selectedPrice}
                    </span>
                ) : (
                    <span className="canvas-model-picker-text min-w-0 flex-1 truncate text-left">{triggerText}</span>
                )}
            </SelectTrigger>
            <SelectContent
                data-canvas-no-zoom
                className="z-[1200] w-80 max-w-[calc(100vw-24px)] rounded-xl border border-border/70 bg-popover p-1 shadow-xl"
                position="popper"
                align="start"
                side="bottom"
                sideOffset={6}
                onPointerDown={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
            >
                {options.length ? (
                    options.map((option) => (
                        <SelectItem key={option.key} value={option.key} textValue={`${"workflowRef" in option ? option.label : modelLabel(option.model, option)} ${option.model} ${option.channelName}`}>
                            <ModelLabel
                                model={"workflowRef" in option ? option.workflowRef.workflowId : option.model}
                                label={"workflowRef" in option ? `工作流 · ${option.label}` : modelLabel(option.model, option)}
                                channelName={option.channelName}
                                price={pricing?.models.has(fitModelOf(option)) ? <FitPrice pricing={pricing} model={fitModelOf(option)} className="truncate text-[11px]" /> : null}
                            />
                        </SelectItem>
                    ))
                ) : (
                    <SelectItem value="__empty__" disabled>
                        {!hasFitToken ? (keyKind ? missingFitKeyMessage(keyKind) : "请在设置中查看模型服务状态") : capability === "audio" ? "当前暂无可用的语音模型" : "当前暂无这类模型"}
                    </SelectItem>
                )}
            </SelectContent>
        </Select>
    );
}

function ModelLabel({ model, label, channelName, price }: { model: string; label?: string; channelName?: string; price?: ReactNode }) {
    const name = (
        <span className="truncate" title={model}>
            {label || model}
        </span>
    );
    return (
        <span className="flex min-w-0 items-center gap-2">
            <ModelIcon model={model} />
            {price ? (
                <span className="flex min-w-0 flex-col">
                    {name}
                    {price}
                </span>
            ) : (
                name
            )}
            {channelName ? <span className="ml-auto max-w-24 shrink-0 truncate text-xs opacity-50">{channelName}</span> : null}
        </span>
    );
}

/** 选项是 openai.fit 渠道里的模型时返回模型名，工作流和别的渠道返回空串。 */
function fitModelOf(option: PickerOption | undefined) {
    return option && !("workflowRef" in option) && option.channelId === FIT_CHANNEL_ID ? option.model : "";
}

/**
 * openai.fit 模型的价格，和 fit 模型广场、在线生成台同一套代码算：按 token 计价的写输入、输出两项（fitTokenPriceText），其余用 fit 生成台的 ModelPriceHint；
 * selection 是选中模型当前的清晰度、时长，ModelPriceHint 拿它估一条的价格。
 */
export function FitPrice({ pricing, model, selection, className }: { pricing: FitPricing; model: string; selection?: { resolution: string | null; seconds: number | null }; className?: string }) {
    const entry = pricing.models.get(model);
    if (!entry) return null;
    const tokenText = fitTokenPriceText(entry, pricing);
    if (tokenText) return <span className={cn("font-mono text-xs tabular-nums text-muted-foreground", className)}>{tokenText}</span>;
    return <ModelPriceHint model={entry} priceRate={pricing.priceRate} usdExchangeRate={pricing.usdExchangeRate} resolution={selection?.resolution} seconds={selection?.seconds} className={className} />;
}

function ModelIcon({ model }: { model: string }) {
    const icon = resolveModelIcon(model);
    return icon ? <img src={icon} alt="" className="size-4 shrink-0 dark:invert" /> : <Cpu className="size-4 shrink-0 opacity-70" />;
}

function resolveModelIcon(model: string) {
    const name = model.toLowerCase();
    if (name.includes("claude") || name.includes("anthropic")) return "/icons/claude.svg";
    if (name.includes("gemini") || name.includes("google")) return "/icons/gemini.svg";
    if (name.includes("gpt") || name.includes("openai")) return "/icons/openai.svg";
    if (name.includes("grok") || name.includes("grok")) return "/icons/grok.svg";
    if (name.includes("deepseek") || name.includes("deepseek")) return "/icons/deepseek.svg";
    if (name.includes("glm") || name.includes("glm")) return "/icons/glm.svg";
    return "";
}
