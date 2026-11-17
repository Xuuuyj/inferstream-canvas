"use client";

import { useMemo } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";

import { applyFitModels, fitChannel, fitKeyForModel, fitKeySet, hasLegacyStoredKey, migrateFitKeys, normalizeFitApiKey, normalizeFitConfig, withFitKeySlot, withFitManualKey, withoutBridgeFitKeys, withoutFitKeys } from "@/lib/fit-config";
import { clearHostedUploadCache } from "@/lib/fit-generate/lib/upload-client";
import { inferStreamImageModel, inferStreamImageToken } from "@/lib/inferstream-image-access";
import { FIT_ORIGIN, directAIProviderForProtocol, isWorkflowProtocol, type DirectAIProvider, type ModelChannelProtocol } from "@/lib/model-channel";
import type { WorkflowRef, WorkflowSummary } from "@/lib/workflow-channel";
import { clearFitStudioCache, loadFitStudio } from "@/services/api/fit/catalog";
import { fetchFitTokenInfo } from "@/services/api/fit/token";
import { apiGet } from "@/services/api/request";
import type { AdminPublicSettings } from "@/services/api/admin";

export type LocalModelChannel = {
    id: string;
    protocol: ModelChannelProtocol;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
    modelCapabilities?: ModelCapabilities;
    uploadApiKey?: string;
    bridgeId?: string;
    comfyUrl?: string;
    workflowDir?: string;
    workflowSummaries?: WorkflowSummary[];
};

export type VideoMultiPromptItem = { prompt: string; duration: string };
export type VideoElementReference = { id: string; kind: "image" | "video" | "audio"; name: string; type: string; dataUrl?: string; url?: string; storageKey?: string; bytes?: number; width?: number; height?: number; durationMs?: number };
export type VideoElementItem = { name: string; description: string; references: VideoElementReference[] };

/** 画布按模型类型分三把 openai.fit 令牌：视频（含上传参考素材、轮询、下载）、图片、文本（含语音）。 */
export type FitKind = "video" | "image" | "text";
/** 一个令牌槽位：令牌 id、名字、分组和完整密钥（只在本浏览器，永不上传）。 */
export type FitKeySlot = { tokenId: number; name: string; group: string; apiKey: string };
/** fitKeys 属于哪个 openai.fit 用户（fit 退出或换了人就清空槽位）；checkedAt 是最近一次用桥接页 hello 核对这个账号的时间（毫秒）。 */
export type FitAccount = { userId: number; displayName: string; checkedAt?: number };

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    model: string;
    imageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    imageWorkflowRef?: WorkflowRef;
    videoWorkflowRef?: WorkflowRef;
    audioWorkflowRef?: WorkflowRef;
    workflowSyncTouched?: boolean;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    grokTtsVoice: string;
    grokTtsLanguage: string;
    grokTtsFormat: string;
    grokTtsSpeed: string;
    glmTtsVoice: string;
    glmTtsFormat: string;
    glmTtsSpeed: string;
    mimoTtsVoice: string;
    mimoTtsFormat: string;
    mimoVoiceDesignPrompt: string;
    geminiTtsVoice: string;
    miniMaxTtsVoice: string;
    miniMaxTtsFormat: string;
    miniMaxTtsSpeed: string;
    videoSeconds: string;
    videoMode: string;
    videoNegativePrompt: string;
    videoMultiShot: string;
    videoShotType: string;
    videoMultiPrompt: VideoMultiPromptItem[];
    videoElementList: VideoElementItem[];
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    videoCharacterOrientation: string;
    systemPrompt: string;
    models: string[];
    imageModels: string[];
    videoModels: string[];
    textModels: string[];
    audioModels: string[];
    quality: string;
    size: string;
    videoSize: string;
    count: string;
    canvasImageCount: string;
    nodeRegenerateBehavior: "new-node" | "overwrite";
    timeout: string;
    apiMode: string;
    streamImages: string;
    streamPartialImages: string;
    responseFormatB64Json: string;
    codexCli: string;
    systemPrompts: {
        image: string;
        video: string;
        text: string;
        workflow: string;
        workflowAgent: string;
    };
    localChannels: LocalModelChannel[];
    publicChannels: Array<{ id?: string; protocol?: LocalModelChannel["protocol"]; name?: string; baseUrl?: string; models?: string[]; modelCapabilities?: ModelCapabilities; parameterTranslationModels?: string[]; workflows?: WorkflowSummary[]; weight?: number; timeout?: number; enabled?: boolean; remark?: string }>;
    syncStorageConfig: boolean;
    syncWebDAVStorageConfig: boolean;
    activeChannelId: string;
    imageChannelId: string;
    videoChannelId: string;
    textChannelId: string;
    audioChannelId: string;
    /** 视频、图片、文本三把令牌（openai.fit 桥接页取来，或在设置里换）；永不上传、不从服务器回填。 */
    fitKeys: Partial<Record<FitKind, FitKeySlot>>;
    /** 手动填写的令牌（高级备用，含 #apiKey= 链接导入）：不为空时视频、图片、文本都用它。 */
    fitManualKey: string;
    fitAccount?: FitAccount;
    /** 手动令牌的名字和到期时间（三把槽位令牌时为空）。 */
    fitTokenName?: string;
    fitTokenExpiresAt?: number;
    /** 模型列表最后一次按当前令牌同步的时间；换令牌时清零。 */
    fitTokenCheckedAt?: number;
    /** openai.fit 卡片高级参数的取值（画质、AI 润色、人脸处理），由 fit 参数面板写入，换算见 services/api/fit/values.ts。 */
    fitAdvanced?: Record<string, boolean | number | string>;
};

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ModelCapabilities = Partial<Record<string, ModelCapability>>;

export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: FIT_ORIGIN,
    fitKeys: {},
    fitManualKey: "",
    model: "gpt-image-2",
    imageModel: "gpt-image-2",
    videoModel: "grok-imagine-video",
    textModel: "gpt-5.5",
    audioModel: "gpt-4o-mini-tts",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    grokTtsVoice: "eve",
    grokTtsLanguage: "auto",
    grokTtsFormat: "mp3",
    grokTtsSpeed: "1",
    glmTtsVoice: "tongtong",
    glmTtsFormat: "wav",
    glmTtsSpeed: "1",
    mimoTtsVoice: "冰糖",
    mimoTtsFormat: "wav",
    mimoVoiceDesignPrompt: "",
    geminiTtsVoice: "Kore",
    miniMaxTtsVoice: "female-yujie",
    miniMaxTtsFormat: "mp3",
    miniMaxTtsSpeed: "1",
    videoSeconds: "6",
    videoMode: "std",
    videoNegativePrompt: "",
    videoMultiShot: "false",
    videoShotType: "intelligence",
    videoMultiPrompt: [{ prompt: "", duration: "1" }],
    videoElementList: [{ name: "", description: "", references: [] }],
    vquality: "720",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    videoCharacterOrientation: "video",
    systemPrompt: "",
    models: [],
    imageModels: [],
    videoModels: [],
    textModels: [],
    audioModels: [],
    quality: "auto",
    size: "1:1",
    videoSize: "1280x720",
    count: "1",
    canvasImageCount: "1",
    nodeRegenerateBehavior: "new-node",
    timeout: "600",
    apiMode: "images",
    streamImages: "",
    streamPartialImages: "1",
    responseFormatB64Json: "",
    codexCli: "",
    systemPrompts: {
        image: "",
        video: "",
        text: "",
        workflow: "",
        workflowAgent: "",
    },
    localChannels: [],
    publicChannels: [],
    syncStorageConfig: false,
    syncWebDAVStorageConfig: false,
    activeChannelId: "",
    imageChannelId: "",
    videoChannelId: "",
    textChannelId: "",
    audioChannelId: "",
};

export type FitRefreshResult = { tokenName: string; counts: Record<ModelCapability, number>; errors: Partial<Record<FitKind, string>> };

type ConfigStore = {
    config: AiConfig;
    publicSettings: AdminPublicSettings | null;
    isPublicSettingsLoading: boolean;
    isConfigOpen: boolean;
    shouldPromptContinue: boolean;
    fitTokenError: string;
    /** 每类令牌最近一次同步模型时的错误（例如这把令牌验证失败），不持久化。 */
    fitKeyErrors: Partial<Record<FitKind, string>>;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    loadPublicSettings: () => Promise<void>;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    setFitManualKey: (apiKey: string) => void;
    setFitKeySlot: (kind: FitKind, slot: FitKeySlot | null) => void;
    setFitAccount: (account: FitAccount | undefined) => void;
    clearFitKeys: () => void;
    /** fit 退出或换了人：只清桥接页取来的三把令牌和 fitAccount，手动令牌保留。 */
    clearBridgeFitKeys: () => void;
    refreshFitModels: () => Promise<FitRefreshResult | null>;
    openConfigDialog: (shouldPromptContinue?: boolean) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

/** 画布服务器不再替用户调用模型：生成请求一律由浏览器直连 openai.fit。 */
export function usesCanvasBackend() {
    return false;
}

function resolveEffectiveConfig(config: AiConfig): AiConfig {
    const localChannels = normalizeLocalChannels(config);
    return {
        ...config,
        channelMode: "local",
        localChannels,
        models: normalizeModelList(localChannels.flatMap((channel) => channel.models)),
        publicChannels: [],
    };
}

function isVideoModelName(model: string) {
    const value = model.toLowerCase();
    return (
        value === "wan2.2animate-v4-motion_retargeting" ||
        value.includes("video") ||
        value.includes("seedance") ||
        value.includes("sora") ||
        value.includes("veo") ||
        value.includes("kling") ||
        value.includes("hailuo") ||
        value.includes("minimax-h3") ||
        value.includes("skyreels") ||
        value.includes("happyhorse") ||
        value.includes("runway") ||
        value.includes("aleph") ||
        value.includes("vidu") ||
        value.includes("pixverse") ||
        value.includes("omni-flash") ||
        value.includes("gemini-omni-video") ||
        value.includes("veo3.1") ||
        value.includes("veo-3.1") ||
        value.includes("infinitalk") ||
        value.includes("wan2-5") ||
        value.includes("wan2.5") ||
        value.includes("wan2-6") ||
        value.includes("wan2.6") ||
        value.includes("wan2-7") ||
        value.includes("wan2.7") ||
        value.includes("wan2-7-r2v") ||
        value.includes("wan2.7-r2v") ||
        value.includes("wan2-7-videoedit") ||
        value.includes("wan2.7-videoedit") ||
        value.includes("wan/2-5") ||
        value.includes("wan/2-6") ||
        value.includes("wan/2-7-text-to-video") ||
        value.includes("wan/2-7-image-to-video") ||
        value.includes("wan/2-7-videoedit") ||
        value.includes("wan/2-7-r2v") ||
        (value.includes("sd") && !value.includes("sdxl")) ||
        (value.includes("grok-imagine") && (value.includes("/upscale") || value.includes("/extend")))
    );
}

function isImageModelName(model: string) {
    const value = model.toLowerCase();
    return !isVideoModelName(model) && !isAudioModelName(model) && (
        value.includes("image") ||
        value.includes("nano-banana") ||
        value.includes("seedream") ||
        value.includes("gpt-image") ||
        value.includes("cogview") ||
        value.includes("dall-e") ||
        value.includes("dalle") ||
        value.includes("imagen") ||
        value.includes("gemini-2.5-flash") ||
        value.includes("gemini-3-pro") ||
        value.includes("gemini-3.1-flash") ||
        value.includes("flux") ||
        value.includes("kontext") ||
        value.includes("4o-image") ||
        value.includes("4o image") ||
        value.includes("gpt-4o-image") ||
        value.includes("z-image") ||
        value.includes("qwen/image") ||
        value.includes("qwen2/image") ||
        value.includes("qwen/text-to-image") ||
        value.includes("qwen2/text-to-image") ||
        value.includes("ideogram") ||
        value.includes("recraft") ||
        value.includes("sdxl") ||
        value.includes("stable-diffusion") ||
        value.includes("midjourney") ||
        value.includes("wan2-7-image") ||
        value.includes("wan2.7-image") ||
        value.includes("wan/2-7-image") ||
        value.includes("topaz/image") ||
        value.includes("gemini-omni-character") ||
        (value.includes("grok-imagine") && !value.includes("video"))
    );
}

function isAudioModelName(model: string) {
    const value = model.toLowerCase();
    return value.includes("audio") || value.includes("tts") || value.includes("speech") || value.includes("voice") || value.includes("music") || value.includes("sound") || value.includes("elevenlabs") || value.includes("suno") || value.includes("lyrics") || value.includes("vocal") || value.includes("midi") || value.includes("wav");
}

function isTextModelName(model: string) {
    return !isImageModelName(model) && !isVideoModelName(model) && !isAudioModelName(model);
}

export function modelMatchesCapability(model: string, capability?: ModelCapability, protocol = "", modelCapabilities: ModelCapabilities = {}) {
    if (!capability) return true;
    if (Object.hasOwn(modelCapabilities, model)) return modelCapabilities[model] === capability;
    if (protocol === "autodl") {
        if (capability === "audio") return model === "indextts2-v1";
        return capability === "video" && (model.startsWith("minimax_h3_") || model === "wan2.2animate-v4-motion_retargeting");
    }
    if (protocol === "gemini") {
        const value = model.toLowerCase();
        const video = /^models\/veo-|^veo-/.test(value);
        const audio = value.includes("tts");
        const image = !video && !audio && value.includes("image");
        if (capability === "video") return video;
        if (capability === "audio") return audio;
        if (capability === "image") return image;
        return !video && !audio && !image;
    }
    if (capability === "image") return isImageModelName(model);
    if (capability === "video") return isVideoModelName(model);
    if (capability === "audio") return isAudioModelName(model);
    return isTextModelName(model);
}

export function filterModelsByCapability(models: string[], capability?: ModelCapability, protocol = "", modelCapabilities: ModelCapabilities = {}) {
    return capability ? models.filter((model) => modelMatchesCapability(model, capability, protocol, modelCapabilities)) : models;
}

export function filterChannelModelsByCapability(channels: Array<{ protocol?: LocalModelChannel["protocol"]; models: string[]; modelCapabilities?: ModelCapabilities }>, capability: ModelCapability, allowedModels?: string[]) {
    const allowed = allowedModels ? new Set(allowedModels) : null;
    return normalizeModelList(channels.flatMap((channel) => isWorkflowProtocol(channel.protocol || "") ? [] : filterModelsByCapability(channel.models, capability, channel.protocol || "", channel.modelCapabilities))).filter((model) => !allowed || allowed.has(model));
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    const channels = config.channelMode === "remote" ? config.publicChannels.map((channel) => ({ ...channel, models: channel.models || [] })) : normalizeLocalChannels(config);
    return filterChannelModelsByCapability(channels, capability, config.models);
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const configuredModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    const selectableModels = selectableModelsByCapability(config, capability);
    const channels = config.channelMode === "remote" ? config.publicChannels : config.localChannels;
    const matches = (model: string | undefined) => Boolean(model && (selectableModels.length || channels.some((channel) => channel.models?.includes(model) && channel.modelCapabilities?.[model]) ? selectableModels.includes(model) : modelMatchesCapability(model, capability)));
    if (matches(currentModel)) return currentModel!;
    if (matches(configuredModel)) return configuredModel;
    return selectableModels[0] || (matches(fallbackModel) ? fallbackModel : "");
}

/** 这个模型对应类型（视频、图片、文本；语音算文本）的令牌有了才算配好。 */
function isAiConfigReady(config: AiConfig, model: string) {
    return Boolean(model.trim() && fitKeyForModel(config, model));
}

/** 本次读到的本地配置里有旧版明文令牌，读完要写回一次。 */
let legacyKeyLoaded = false;

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            publicSettings: null,
            isPublicSettingsLoading: false,
            isConfigOpen: false,
            shouldPromptContinue: false,
            fitTokenError: "",
            fitKeyErrors: {},
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            loadPublicSettings: async () => {
                if (get().isPublicSettingsLoading) return;
                set({ isPublicSettingsLoading: true });
                try {
                    set({ publicSettings: await apiGet<AdminPublicSettings>("/api/settings") });
                } finally {
                    set({ isPublicSettingsLoading: false });
                }
            },
            isAiConfigReady: (config, model) => {
                if (get().publicSettings?.auth?.inferStreamLogin === true && model === inferStreamImageModel) {
                    return Boolean(inferStreamImageToken());
                }
                return isAiConfigReady(config, model);
            },
            setFitManualKey: (apiKey) => set((state) => ({ fitTokenError: "", fitKeyErrors: {}, config: withFitManualKey(state.config, apiKey) })),
            setFitKeySlot: (kind, slot) => set((state) => ({ fitTokenError: "", fitKeyErrors: { ...state.fitKeyErrors, [kind]: undefined }, config: withFitKeySlot(state.config, kind, slot) })),
            setFitAccount: (fitAccount) => set((state) => ({ config: { ...state.config, fitAccount } })),
            clearFitKeys: () => {
                // 连同这些令牌的模型、卡片缓存和它们传到 openai.fit 的参考素材地址（localStorage，地址不用令牌就能打开）一起清掉
                clearFitStudioCache();
                clearHostedUploadCache();
                set((state) => ({ fitTokenError: "", fitKeyErrors: {}, config: withoutFitKeys(state.config) }));
            },
            clearBridgeFitKeys: () => {
                clearFitStudioCache();
                clearHostedUploadCache();
                set((state) => ({ fitKeyErrors: {}, config: withoutBridgeFitKeys(state.config) }));
            },
            refreshFitModels: async () => {
                const keys = fitKeySet(get().config);
                const signature = JSON.stringify(keys);
                const stillCurrent = () => JSON.stringify(fitKeySet(get().config)) === signature;
                try {
                    if (!keys.video && !keys.image && !keys.text) throw new Error("缺少可用的模型服务令牌");
                    // 三把令牌各请求一次 /v1/models（同一把只请求一次）；只有手动令牌才读名字和到期时间（这个接口占 openai.fit 的限频）
                    clearFitStudioCache({ keepCatalog: true });
                    const manualKey = normalizeFitApiKey(get().config.fitManualKey);
                    const [list, info] = await Promise.all([loadFitStudio(keys), manualKey ? fetchFitTokenInfo(manualKey).catch(() => null) : null]);
                    if (!stillCurrent()) return null;
                    const tokenName = info?.name || "";
                    set((state) => ({ fitTokenError: "", fitKeyErrors: list.errors, config: applyFitModels(state.config, { list, tokenName, expiresAt: info?.expiresAt || 0, checkedAt: Date.now() }) }));
                    return { tokenName, counts: list.counts, errors: list.errors };
                } catch (error) {
                    const message = error instanceof Error ? error.message : "原模型服务令牌验证失败";
                    if (stillCurrent()) set({ fitTokenError: message });
                    throw new Error(message);
                }
            },
            openConfigDialog: (shouldPromptContinue = false) => set({ isConfigOpen: true, shouldPromptContinue }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            partialize: (state) => ({ config: state.config }),
            // 旧版存的明文令牌（顶层 apiKey、渠道里的 apiKey）读进来就按新格式写回一次，不等下次改设置
            onRehydrateStorage: () => () => {
                if (legacyKeyLoaded) queueMicrotask(() => useConfigStore.setState((state) => ({ config: { ...state.config } })));
            },
            merge: (persisted, current) => {
                const persistedState = (persisted || {}) as Partial<ConfigStore>;
                const { apiKey: _legacyKey, ...persistedConfig } = (persistedState.config || {}) as Partial<AiConfig> & { apiKey?: unknown };
                // 旧版只有一把 apiKey：迁移成手动令牌（三类都用它），旧字段不再留在配置里；槽位里格式不对的丢掉
                legacyKeyLoaded = hasLegacyStoredKey((persistedState.config || {}) as Partial<AiConfig>);
                const config = normalizeFitConfig({ ...defaultConfig, ...persistedConfig, ...migrateFitKeys((persistedState.config || {}) as Partial<AiConfig>) });
                const modelChannels = config.localChannels;
                return {
                    ...current,
                    config: {
                        ...config,
                        syncStorageConfig: config.syncStorageConfig === true,
                        syncWebDAVStorageConfig: config.syncWebDAVStorageConfig === true,
                        imageModel: config.imageModel || config.model,
                        videoModel: config.videoModel || "grok-imagine-video",
                        textModel: config.textModel || config.model,
                        audioModel: config.audioModel || defaultConfig.audioModel,
                        audioVoice: config.audioVoice || defaultConfig.audioVoice,
                        audioFormat: config.audioFormat || defaultConfig.audioFormat,
                        audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                        grokTtsVoice: config.grokTtsVoice || defaultConfig.grokTtsVoice,
                        grokTtsLanguage: config.grokTtsLanguage || defaultConfig.grokTtsLanguage,
                        grokTtsFormat: config.grokTtsFormat || defaultConfig.grokTtsFormat,
                        grokTtsSpeed: config.grokTtsSpeed || defaultConfig.grokTtsSpeed,
                        glmTtsVoice: config.glmTtsVoice || defaultConfig.glmTtsVoice,
                        glmTtsFormat: config.glmTtsFormat || defaultConfig.glmTtsFormat,
                        glmTtsSpeed: config.glmTtsSpeed || defaultConfig.glmTtsSpeed,
                        geminiTtsVoice: config.geminiTtsVoice || defaultConfig.geminiTtsVoice,
                        systemPrompts: { ...defaultConfig.systemPrompts, ...(config.systemPrompts || {}) },
                        audioInstructions: config.audioInstructions || "",
                        videoSeconds: config.videoSeconds || "6",
                        videoMode: config.videoMode || "std",
                        videoNegativePrompt: config.videoNegativePrompt || "",
                        videoMultiShot: config.videoMultiShot || "false",
                        videoShotType: config.videoShotType || "intelligence",
                        videoMultiPrompt: Array.isArray(config.videoMultiPrompt) && config.videoMultiPrompt.length ? config.videoMultiPrompt : defaultConfig.videoMultiPrompt,
                        videoElementList: Array.isArray(config.videoElementList) && config.videoElementList.length ? config.videoElementList : defaultConfig.videoElementList,
                        vquality: config.vquality || "720",
                        videoGenerateAudio: config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
                        videoWatermark: config.videoWatermark || "false",
                        videoCharacterOrientation: config.videoCharacterOrientation === "image" ? "image" : "video",
                        canvasImageCount: config.canvasImageCount || "1",
                        imageModels: filterChannelModelsByCapability(modelChannels, "image"),
                        videoModels: filterChannelModelsByCapability(modelChannels, "video"),
                        textModels: filterChannelModelsByCapability(modelChannels, "text"),
                        audioModels: filterChannelModelsByCapability(modelChannels, "audio"),
                    },
                };
            },
        },
    ),
);

function normalizeModelList(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => resolveEffectiveConfig(config), [config]);
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeVersionedBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") || lowerBaseUrl.endsWith("/api/paas/v4") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeVersionedBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        for (const versionPath of ["/api/plan/v3", "/api/paas/v4"]) {
            const versionIndex = lowerPath.indexOf(versionPath);
            if (versionIndex < 0) continue;
            const end = versionIndex + versionPath.length;
            if (lowerPath.length !== end && lowerPath[end] !== "/") continue;
            url.pathname = path.slice(0, end);
            url.search = "";
            url.hash = "";
            return url.toString().replace(/\/+$/, "");
        }
        return baseUrl;
    } catch {
        return baseUrl;
    }
}

/** 永远只有 openai.fit 一条渠道；令牌按 config.model 的类型现算（视频、图片、文本三把之一，手动令牌优先），不存进渠道。 */
export function normalizeLocalChannels(config: Partial<AiConfig>): LocalModelChannel[] {
    return [{ ...fitChannel(config), apiKey: fitKeyForModel(config, config.model || "") }];
}

export function channelIdForActiveModel(config: AiConfig) {
    const channels = (config.channelMode === "remote" ? config.publicChannels : normalizeLocalChannels(config)).filter((channel) => !isWorkflowProtocol(channel.protocol || ""));
    const selectedChannelId = config.model === config.imageModel ? config.imageChannelId : config.model === config.videoModel ? config.videoChannelId : config.model === config.audioModel ? config.audioChannelId : config.model === config.textModel ? config.textChannelId : "";
    const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
    if (config.activeChannelId && channels.some((channel) => channel.id === config.activeChannelId && channel.models?.includes(config.model))) return config.activeChannelId;
    if (selectedChannel?.protocol === "gemini" || selectedChannel?.protocol === "autodl") return selectedChannelId;
    if (!selectedChannel) {
        const geminiChannel = channels.find((channel) => channel.protocol === "gemini" && (channel.models || []).includes(config.model));
        if (geminiChannel) return geminiChannel.id || "";
    }
    if (modelMatchesCapability(config.model, "image") && config.imageChannelId) return config.imageChannelId;
    if (modelMatchesCapability(config.model, "video") && config.videoChannelId) return config.videoChannelId;
    if (modelMatchesCapability(config.model, "audio") && config.audioChannelId) return config.audioChannelId;
    if (modelMatchesCapability(config.model, "text") && config.textChannelId) return config.textChannelId;
    if (config.activeChannelId) return config.activeChannelId;
    if (config.model === config.videoModel) return config.videoChannelId;
    if (config.model === config.textModel) return config.textChannelId;
    if (config.model === config.audioModel) return config.audioChannelId;
    return config.imageChannelId;
}

export function localChannelForActiveModel(config: AiConfig) {
    const channels = normalizeLocalChannels(config).filter((channel) => !isWorkflowProtocol(channel.protocol));
    const preferredId = channelIdForActiveModel(config);
    return channels.find((channel) => channel.id === preferredId && channel.models.includes(config.model)) || channels.find((channel) => channel.models.includes(config.model)) || channels.find((channel) => channel.id === preferredId) || channels[0];
}

export function channelProtocolForConfig(config: AiConfig): LocalModelChannel["protocol"] {
    const channel = config.channelMode === "remote"
        ? config.publicChannels.find((item) => item.id === channelIdForActiveModel(config)) || config.publicChannels.find((item) => !isWorkflowProtocol(item.protocol || ""))
        : localChannelForActiveModel(config);
    return channel?.protocol || "openai";
}

export type { DirectAIProvider } from "@/lib/model-channel";

export function directAIProviderForConfig(config: AiConfig): DirectAIProvider | null {
    return directAIProviderForProtocol(channelProtocolForConfig(config));
}
