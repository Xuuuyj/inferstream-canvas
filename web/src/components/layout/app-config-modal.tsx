"use client";

import { Alert, App, Button, Collapse, Form, Input, Modal, Radio, Select, Switch } from "antd";
import { useEffect, useRef, useState } from "react";

import { GrokTtsVoiceSelect } from "@/components/grok-tts-voice-select";
import { inferStreamImageModel, inferStreamImageToken, saveInferStreamImageToken, verifyInferStreamImageToken } from "@/lib/inferstream-image-access";
import { usePathname } from "next/navigation";

import { FitAccountSection, FitKeySlots, FitManualKeyField } from "@/components/layout/fit-key-slots";
import { MiniMaxTtsVoiceSelect } from "@/components/minimax-tts-voice-select";
import { ModelPicker } from "@/components/model-picker";
import { fetchUserConfig, measureUserStorageProvider, syncUserModelConfig, syncUserStorageProvider } from "@/services/api/user-config";
import { clearStorageConfigCache as clearFileStorageCache } from "@/services/file-storage";
import { clearStorageConfigCache as clearImageStorageCache, defaultUserStorageProvider, defaultUserWebDAVStorageProvider, loadStorageConfig, loadUserS3StorageProvider, loadUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider, type UserStorageProvider } from "@/services/image-storage";
import { audioFormatOptions, audioVoiceOptions, glmTtsFormatOptions, glmTtsVoiceOptions, isGlmTtsModel, normalizeAudioSpeedValue, normalizeGlmTtsFormat, normalizeGlmTtsSpeed, normalizeGlmTtsVoice } from "@/lib/audio-generation";
import { FIT_KIND_LABELS, FIT_KINDS, fitKeyFor, fitKeysComplete, hasAnyFitKey, syncedPreferences } from "@/lib/fit-config";
import { grokTtsFormatOptions, grokTtsLanguageOptions, isGrok2APITtsConfig, normalizeGrokTtsFormat, normalizeGrokTtsLanguage, normalizeGrokTtsSpeed } from "@/lib/grok-tts";
import { isGeminiConfig, isGeminiTtsModel } from "@/lib/gemini";
import { geminiTtsVoiceOptions, normalizeGeminiTtsVoice } from "@/lib/gemini-tts";
import { isMiniMaxTtsConfig, miniMaxTtsFormatOptions, normalizeMiniMaxTtsFormat, normalizeMiniMaxTtsSpeed, normalizeMiniMaxTtsVoice } from "@/lib/minimax-tts";
import { miniMaxTtsVoiceOptions } from "@/lib/minimax-tts-voices";
import { isMimoPresetTtsModel, isMimoTtsModel, isMimoVoiceCloneModel, isMimoVoiceDesignModel, mimoTtsFormatOptions, mimoTtsVoiceOptions } from "@/lib/mimo-tts";
import { channelProtocolForConfig, useConfigStore, useEffectiveConfig, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    workflowKey?: "imageWorkflowRef" | "videoWorkflowRef" | "audioWorkflowRef";
    channelKey: "imageChannelId" | "videoChannelId" | "textChannelId" | "audioChannelId";
    modelsKey: "imageModels" | "videoModels" | "textModels" | "audioModels";
    defaultLabel: string;
    optionsLabel: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", workflowKey: "imageWorkflowRef", channelKey: "imageChannelId", modelsKey: "imageModels", defaultLabel: "默认生图模型", optionsLabel: "生图模型可选项" },
    { capability: "video", modelKey: "videoModel", workflowKey: "videoWorkflowRef", channelKey: "videoChannelId", modelsKey: "videoModels", defaultLabel: "默认视频模型", optionsLabel: "视频模型可选项" },
    { capability: "text", modelKey: "textModel", channelKey: "textChannelId", modelsKey: "textModels", defaultLabel: "默认文本模型", optionsLabel: "文本模型可选项" },
    { capability: "audio", modelKey: "audioModel", workflowKey: "audioWorkflowRef", channelKey: "audioChannelId", modelsKey: "audioModels", defaultLabel: "默认音频模型", optionsLabel: "音频模型可选项" },
];

export function AppConfigModal() {
    const { message } = App.useApp();
    const [savingConfig, setSavingConfig] = useState(false);
    const accountConfigRef = useRef<{ ready: boolean }>({ ready: false });
    const [remoteStorageSyncEnabled, setRemoteStorageSyncEnabled] = useState(false);
    const [remoteWebDAVStorageSyncEnabled, setRemoteWebDAVStorageSyncEnabled] = useState(false);
    const [allowUserStorageProvider, setAllowUserStorageProvider] = useState(false);
    const [userStorage, setUserStorage] = useState(() => defaultUserStorageProvider());
    const [userWebDAVStorage, setUserWebDAVStorage] = useState(() => defaultUserWebDAVStorageProvider());
    const [measuringStorageType, setMeasuringStorageType] = useState<"s3" | "webdav" | null>(null);
    const [storageUsageText, setStorageUsageText] = useState("");
    const [webDAVStorageUsageText, setWebDAVStorageUsageText] = useState("");
    const pathname = usePathname();
    const [imageTokenInput, setImageTokenInput] = useState("");
    const [imageTokenBusy, setImageTokenBusy] = useState(false);
    const [imageTokenReady, setImageTokenReady] = useState(false);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const inferStreamLogin = publicSettings?.auth?.inferStreamLogin === true;
    const legacyTokenSettings = publicSettings !== null && !inferStreamLogin;
    const clearFitKeys = useConfigStore((state) => state.clearFitKeys);
    const config = useConfigStore((state) => state.config);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const refreshFitModels = useConfigStore((state) => state.refreshFitModels);
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    useEffect(() => {
        setImageTokenInput("");
        setImageTokenReady(isConfigOpen && !!user?.id && !!inferStreamImageToken(user.id));
    }, [isConfigOpen, user?.id]);

    const connectImageToken = async () => {
        const value = imageTokenInput.trim();
        const userId = user?.id;
        if (!userId || !value || imageTokenBusy) return false;
        setImageTokenBusy(true);
        try {
            await verifyInferStreamImageToken(value);
            if (useUserStore.getState().user?.id !== userId) return false;
            saveInferStreamImageToken(userId, value);
            setImageTokenInput("");
            setImageTokenReady(true);
            message.success("InferStream 生图已连接。");
            return true;
        } catch (error) {
            message.error(error instanceof Error ? error.message : "连接 InferStream 失败。");
            return false;
        } finally {
            setImageTokenBusy(false);
        }
    };

    const modelConfig = useEffectiveConfig();
    const canUseUserStorageProvider = allowUserStorageProvider;
    const glmTts = isGlmTtsModel(config.audioModel);
    const audioConfig = { ...modelConfig, model: config.audioModel, audioModel: config.audioModel, activeChannelId: modelConfig.audioChannelId || modelConfig.activeChannelId };
    const grokTts = isGrok2APITtsConfig(audioConfig, config.audioModel);
    const geminiTts = isGeminiTtsModel(config.audioModel) && isGeminiConfig(audioConfig, config.audioModel);
    const miniMaxTts = isMiniMaxTtsConfig(audioConfig, config.audioModel);
    const officialMiniMaxTts = miniMaxTts && channelProtocolForConfig(audioConfig) === "minimax";
    // 生成时缺令牌打开的弹窗（shouldPromptContinue）：说清楚缺哪几把
    const missingKinds = FIT_KINDS.filter((kind) => !fitKeyFor(config, kind));

    useEffect(() => {
        setUserStorage(loadUserS3StorageProvider() || defaultUserStorageProvider());
        setUserWebDAVStorage(loadUserWebDAVStorageProvider() || defaultUserWebDAVStorageProvider());
        accountConfigRef.current = { ready: false };
        if (!isConfigOpen || !token || !user?.id) return;
        const accountToken = token;
        const accountId = user.id;
        let canceled = false;
        void fetchUserConfig(accountToken)
            .then((payload) => {
                if (canceled || useUserStore.getState().token !== accountToken || useUserStore.getState().user?.id !== accountId) return;
                const remoteConfig = payload.modelConfig;
                const syncS3 = remoteConfig?.syncStorageConfig === true;
                const syncWebDAV = remoteConfig?.syncWebDAVStorageConfig === true;
                setRemoteStorageSyncEnabled(syncS3);
                setRemoteWebDAVStorageSyncEnabled(syncWebDAV);
                if (remoteConfig) {
                    Object.entries(syncedPreferences(remoteConfig))
                        .forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
                }
                accountConfigRef.current = { ready: true };
                updateConfig("syncStorageConfig", syncS3);
                updateConfig("syncWebDAVStorageConfig", syncWebDAV);
                if (syncS3 && payload.storageProvider?.s3) {
                    const next = { ...defaultUserStorageProvider(), ...payload.storageProvider.s3, type: "s3" as const };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
                if (syncWebDAV && payload.storageProvider?.webdav) {
                    const next = { ...defaultUserWebDAVStorageProvider(), ...payload.storageProvider.webdav, type: "webdav" as const };
                    setUserWebDAVStorage(next);
                    saveUserWebDAVStorageProvider(next);
                }
            })
            .catch(() => { });
        return () => {
            canceled = true;
        };
    }, [isConfigOpen, token, updateConfig, user?.id]);

    useEffect(() => {
        if (!isConfigOpen) return;
        let canceled = false;
        void loadStorageConfig()
            .then((storage) => {
                if (!canceled) setAllowUserStorageProvider(storage.allowUserProvider === true);
            })
            .catch(() => {
                if (!canceled) setAllowUserStorageProvider(false);
            });
        return () => {
            canceled = true;
        };
    }, [isConfigOpen]);

    const finishConfig = async () => {
		if (userStorage.enabled && userWebDAVStorage.enabled) {
			message.error("S3/R2 与 WebDAV 不能同时启用");
			return;
		}
		if (token && !accountConfigRef.current.ready) {
			message.warning("账号配置仍在加载，请稍后再保存");
			return;
		}
        if (canUseUserStorageProvider) {
            saveUserStorageProvider(userStorage);
            saveUserWebDAVStorageProvider(userWebDAVStorage);
        }
        setSavingConfig(true);
		try {
            if (inferStreamLogin && imageTokenInput.trim() && !await connectImageToken()) return;
            if (legacyTokenSettings && hasAnyFitKey(config) && !config.fitTokenCheckedAt) await refreshFitModels();
            const saved = useConfigStore.getState().config;
			if (token) await syncUserModelConfig(token, saved);
            const providers = {
                ...(config.syncStorageConfig || remoteStorageSyncEnabled ? { s3: config.syncStorageConfig ? userStorage : { ...userStorage, enabled: false, endpoint: "", bucket: "", accessKeyId: "", secretAccessKey: "" } } : {}),
                ...(config.syncWebDAVStorageConfig || remoteWebDAVStorageSyncEnabled ? { webdav: config.syncWebDAVStorageConfig ? userWebDAVStorage : { ...userWebDAVStorage, enabled: false, endpoint: "", username: "", password: "" } } : {}),
            };
            if (token && canUseUserStorageProvider && Object.keys(providers).length) {
                await syncUserStorageProvider(token, providers);
                setRemoteStorageSyncEnabled(config.syncStorageConfig);
                setRemoteWebDAVStorageSyncEnabled(config.syncWebDAVStorageConfig);
            }
            clearImageStorageCache();
            clearFileStorageCache();
            setConfigDialogOpen(false);
            if ((config.syncStorageConfig || config.syncWebDAVStorageConfig) && !token) message.warning("请登录后再同步配置");
            else if (legacyTokenSettings && (!fitKeysComplete(saved) || !saved.imageModel.trim() || !saved.videoModel.trim() || !saved.textModel.trim())) message.warning("令牌或默认模型还没配齐，配置已保存");
            else message.success(legacyTokenSettings && shouldPromptContinue ? "配置已保存，请继续刚才的请求" : "配置已保存");
            clearPromptContinue();
        } catch (error) {
            message.error(error instanceof Error ? "保存配置失败：" + error.message : "保存配置失败");
        } finally {
            setSavingConfig(false);
        }
    };

    const measureStorage = async (provider: UserStorageProvider) => {
        if (!token) {
            message.warning("请先登录后再统计容量");
            return;
        }
        setMeasuringStorageType(provider.type);
        try {
            const result = await measureUserStorageProvider(token, provider);
            const usageText = formatBytes(result.bytes) + " / " + formatBytes(result.limitBytes) + (result.overLimit ? "，已达到上限" : "");
            if (provider.type === "webdav") {
                setWebDAVStorageUsageText(usageText);
                if (result.overLimit) {
                    const next = { ...userWebDAVStorage, enabled: false };
                    setUserWebDAVStorage(next);
                    saveUserWebDAVStorageProvider(next);
                }
            } else {
                setStorageUsageText(usageText);
                if (result.overLimit) {
                    const next = { ...userStorage, enabled: false };
                    setUserStorage(next);
                    saveUserStorageProvider(next);
                }
            }
            message.success("容量统计完成");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "容量统计失败");
        } finally {
            setMeasuringStorageType(null);
        }
    };

    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">InferStream 画布设置</div>
                    {legacyTokenSettings ? <div className="mt-1 text-xs font-normal text-stone-500">令牌只保存在本浏览器，只发往 https://openai.fit</div> : null}
                </div>
            }
            open={isConfigOpen}
            width={960}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 18 } }}
            footer={
                <Button type="primary" loading={savingConfig} disabled={imageTokenBusy} onClick={() => void finishConfig()}>
                    完成
                </Button>
            }
        >
            <div className="pt-1">
                <Form layout="vertical" requiredMark={false}>
                    {inferStreamLogin ? (
                        <section className="mb-4 space-y-2 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                            <div className="text-sm font-medium">InferStream 账号</div>
                            {user ? (
                                <div className="text-sm">{user.displayName || user.username}</div>
                            ) : (
                                <Button size="small" href={`/login?redirect=${encodeURIComponent(pathname)}`}>用 InferStream 登录</Button>
                            )}
                            {user ? <>
                                <div className="text-sm">图片生成 · {inferStreamImageModel}{imageTokenReady ? " · 已连接" : ""}</div>
                                <div className="text-xs text-stone-500">填写中转站的 API Token 后，生图和参考图编辑会在 InferStream 计费。验证后记在当前浏览器中，退出登录或断开时清除。</div>
                                <div className="flex flex-wrap gap-2">
                                    <Input.Password className="min-w-56 flex-1" aria-label="InferStream API Token" placeholder="粘贴 InferStream API Token" autoComplete="off" value={imageTokenInput} onChange={(event) => setImageTokenInput(event.target.value)} />
                                    <Button loading={imageTokenBusy} disabled={!imageTokenInput.trim()} onClick={() => void connectImageToken()}>验证并连接</Button>
                                    {imageTokenReady ? <Button disabled={imageTokenBusy} onClick={() => {
                                        saveInferStreamImageToken(user.id, "");
                                        setImageTokenReady(false);
                                    }}>断开</Button> : null}
                                </div>
                                <a className="text-sm underline" href="https://www.inferstream.cn/console/api-keys" target="_blank" rel="noreferrer">管理 InferStream API Token</a>
                            </> : null}
                            {hasAnyFitKey(config) ? <Button size="small" onClick={clearFitKeys}>清除本机旧令牌</Button> : null}
                        </section>
                    ) : null}
                    {legacyTokenSettings ? <>
                    {shouldPromptContinue && missingKinds.length ? <Alert className="mb-4" type="warning" showIcon title={`请先选择${missingKinds.map((kind) => FIT_KIND_LABELS[kind]).join("、")}令牌，选好后点「完成」继续刚才的请求`} /> : null}
                    <section className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <FitAccountSection />
                    </section>
                    <section className="mb-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                        <FitKeySlots />
                    </section>
                    </> : null}
                    <Collapse
                        ghost
                        items={[
                            {
                                key: "more",
                                label: "更多设置",
                                children: (
                                    <>
                                    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                        {modelGroups.map((group) => (
                                            <Form.Item key={group.modelKey} label={group.defaultLabel} className="mb-4">
                                                <ModelPicker config={modelConfig} value={modelConfig[group.modelKey]} channelId={modelConfig[group.channelKey]} workflowRef={group.workflowKey ? modelConfig[group.workflowKey] : undefined} onWorkflowChange={group.workflowKey ? (ref) => updateConfig(group.workflowKey!, ref) : undefined} onChange={(model, channelId) => { updateConfig(group.modelKey, model); if (channelId) updateConfig(group.channelKey, channelId); }} capability={group.capability} fullWidth />
                                            </Form.Item>
                                        ))}
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-4">
                                        <Form.Item label="画布默认生图张数" extra="新建画布生图和配置节点默认使用，单个节点仍可单独覆盖。" className="mb-4">
                                            <Input
                                                type="number"
                                                min={1}
                                                max={15}
                                                value={config.canvasImageCount}
                                                onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                                onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                            />
                                        </Form.Item>
                                        {geminiTts ? (
                                            <Form.Item label="默认 Gemini 音色" className="mb-4">
                                                <Select showSearch optionFilterProp="label" value={normalizeGeminiTtsVoice(config.geminiTtsVoice)} options={geminiTtsVoiceOptions} onChange={(value) => updateConfig("geminiTtsVoice", value)} />
                                            </Form.Item>
                                        ) : isMimoPresetTtsModel(config.audioModel) ? (
                                            <Form.Item label="默认 MiMo 音色" className="mb-4">
                                                <Select value={config.mimoTtsVoice} options={[...mimoTtsVoiceOptions]} onChange={(value) => updateConfig("mimoTtsVoice", value)} />
                                            </Form.Item>
                                        ) : isMimoVoiceDesignModel(config.audioModel) ? (
                                            <Form.Item label="默认音色描述" className="mb-4">
                                                <Input value={config.mimoVoiceDesignPrompt} placeholder="例如：年轻女性，声音清亮自然，有亲和力。" onChange={(event) => updateConfig("mimoVoiceDesignPrompt", event.target.value)} />
                                            </Form.Item>
                                        ) : isMimoTtsModel(config.audioModel) ? null : (
                                            <Form.Item label="默认音频声音" className="mb-4">
                                                {grokTts ? <GrokTtsVoiceSelect config={audioConfig} model={config.audioModel} value={config.grokTtsVoice} enabled={isConfigOpen} onChange={(value) => updateConfig("grokTtsVoice", value)} /> : officialMiniMaxTts ? <MiniMaxTtsVoiceSelect config={audioConfig} model={config.audioModel} value={normalizeMiniMaxTtsVoice(config.miniMaxTtsVoice)} enabled={isConfigOpen} onChange={(value) => updateConfig("miniMaxTtsVoice", value)} /> : <Select showSearch={miniMaxTts} optionFilterProp="label" value={glmTts ? normalizeGlmTtsVoice(config.glmTtsVoice) : miniMaxTts ? normalizeMiniMaxTtsVoice(config.miniMaxTtsVoice) : config.audioVoice} options={glmTts ? glmTtsVoiceOptions : miniMaxTts ? miniMaxTtsVoiceOptions : audioVoiceOptions} onChange={(value) => updateConfig(glmTts ? "glmTtsVoice" : miniMaxTts ? "miniMaxTtsVoice" : "audioVoice", value)} />}
                                            </Form.Item>
                                        )}
                                        {grokTts ? (
                                            <Form.Item label="默认音频语言" className="mb-4">
                                                <Select value={normalizeGrokTtsLanguage(config.grokTtsLanguage)} options={grokTtsLanguageOptions} showSearch optionFilterProp="label" onChange={(value) => updateConfig("grokTtsLanguage", value)} />
                                            </Form.Item>
                                        ) : null}
                                        {!geminiTts ? (
                                            <Form.Item label="默认音频格式" className="mb-4">
                                                <Select value={isMimoTtsModel(config.audioModel) ? config.mimoTtsFormat : glmTts ? normalizeGlmTtsFormat(config.glmTtsFormat) : miniMaxTts ? normalizeMiniMaxTtsFormat(config.miniMaxTtsFormat) : grokTts ? normalizeGrokTtsFormat(config.grokTtsFormat) : config.audioFormat} options={isMimoTtsModel(config.audioModel) ? [...mimoTtsFormatOptions] : glmTts ? glmTtsFormatOptions : miniMaxTts ? miniMaxTtsFormatOptions : grokTts ? grokTtsFormatOptions : audioFormatOptions} onChange={(value) => isMimoTtsModel(config.audioModel) ? updateConfig("mimoTtsFormat", value) : updateConfig(glmTts ? "glmTtsFormat" : miniMaxTts ? "miniMaxTtsFormat" : grokTts ? "grokTtsFormat" : "audioFormat", value)} />
                                            </Form.Item>
                                        ) : null}
                                        {!geminiTts && !isMimoTtsModel(config.audioModel) ? (
                                            <Form.Item label="默认音频语速" className="mb-4">
                                                <Input
                                                    type="number"
                                                    min={glmTts || miniMaxTts ? 0.5 : grokTts ? 0.7 : 0.25}
                                                    max={glmTts || miniMaxTts ? 2 : grokTts ? 1.5 : 4}
                                                    step={0.05}
                                                    value={glmTts ? config.glmTtsSpeed : miniMaxTts ? config.miniMaxTtsSpeed : grokTts ? config.grokTtsSpeed : config.audioSpeed}
                                                    onChange={(event) => updateConfig(glmTts ? "glmTtsSpeed" : miniMaxTts ? "miniMaxTtsSpeed" : grokTts ? "grokTtsSpeed" : "audioSpeed", event.target.value)}
                                                    onBlur={(event) => updateConfig(glmTts ? "glmTtsSpeed" : miniMaxTts ? "miniMaxTtsSpeed" : grokTts ? "grokTtsSpeed" : "audioSpeed", glmTts ? normalizeGlmTtsSpeed(event.target.value) : miniMaxTts ? normalizeMiniMaxTtsSpeed(event.target.value) : grokTts ? normalizeGrokTtsSpeed(event.target.value) : normalizeAudioSpeedValue(event.target.value))}
                                                />
                                            </Form.Item>
                                        ) : null}
                                    </div>
                                    <Form.Item label="已有内容的节点再次生成时" className="mb-4">
                                        <Radio.Group value={config.nodeRegenerateBehavior} onChange={(event) => updateConfig("nodeRegenerateBehavior", event.target.value)} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", width: "100%", gap: 8 }}>
                                            <Radio value="overwrite">
                                                <span className="block text-sm font-medium">覆盖当前节点</span>
                                                <span className="mt-0.5 block text-xs opacity-60">直接替换该节点的内容和参数，想保留旧结果时，先复制或切换节点模式</span>
                                            </Radio>
                                            <Radio value="new-node">
                                                <span className="block text-sm font-medium">新建衍生节点</span>
                                                <span className="mt-0.5 block text-xs opacity-60">保留当前节点，新建一个节点承接生成结果，适合做变体或分支</span>
                                            </Radio>
                                        </Radio.Group>
                                    </Form.Item>
                                    <div className="mb-4 grid gap-3 md:grid-cols-4">
                                        <FeatureSwitch title="流式传输" description="开启后请求中追加 stream，支持读取中间图片并避免长时间无数据。" checked={Boolean(config.streamImages)} onChange={(checked) => updateConfig("streamImages", checked ? "1" : "")} />
                                        <FeatureSwitch title="返回 Base64 图片" description="开启后 Image API 请求会追加 response_format: b64_json。" checked={Boolean(config.responseFormatB64Json)} onChange={(checked) => updateConfig("responseFormatB64Json", checked ? "1" : "")} />
                                        <FeatureSwitch title="Codex CLI 兼容模式" description="开启后减少不兼容参数，并追加防提示词改写前缀。" checked={Boolean(config.codexCli)} onChange={(checked) => updateConfig("codexCli", checked ? "1" : "")} />
                                        <FeatureSwitch title="视频音频生成" description="视频默认生成同步音频。" checked={config.videoGenerateAudio === "true"} onChange={(checked) => updateConfig("videoGenerateAudio", String(checked))} />
                                    </div>
                                    {canUseUserStorageProvider ? (
                                        <>
                                            <section className="mb-5 mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="text-sm font-medium">用户 S3/R2 存储</div>
                                                        <div className="mt-1 text-xs text-stone-500">
                                                            开启后，新生成图片和媒体文件会优先保存到你的 S3 兼容对象存储。
                                                            {storageUsageText ? <>当前容量：{storageUsageText}</> : null}
                                                        </div>
                                                    </div>
                                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                        <Button size="small" loading={measuringStorageType === "s3"} onClick={() => void measureStorage(userStorage)}>
                                                            统计容量
                                                        </Button>
                                                        <span className="text-xs text-stone-500">路径 / 子域名</span>
                                                        <Switch size="small" checked={userStorage.bucketInHost} onChange={(bucketInHost) => setUserStorage((value) => ({ ...value, bucketInHost }))} />
                                                        <span className="text-xs text-stone-500">自动同步</span>
                                                        <Switch size="small" checked={config.syncStorageConfig} onChange={(checked) => updateConfig("syncStorageConfig", checked)} />
                                                        <Switch checked={userStorage.enabled} disabled={userWebDAVStorage.enabled} onChange={(enabled) => setUserStorage((value) => ({ ...value, enabled }))} />
                                                    </div>
                                                </div>
                                                {userStorage.enabled ? (
                                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                                        <Input value={userStorage.name} placeholder="配置名称" onChange={(event) => setUserStorage((value) => ({ ...value, name: event.target.value }))} />
                                                        <Input value={userStorage.endpoint} placeholder="Endpoint，例如 https://<account>.r2.cloudflarestorage.com" onChange={(event) => setUserStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                                        <Input value={userStorage.region} placeholder="Region，R2 通常为 auto" onChange={(event) => setUserStorage((value) => ({ ...value, region: event.target.value }))} />
                                                        <Input value={userStorage.bucket} placeholder="Bucket 名称" onChange={(event) => setUserStorage((value) => ({ ...value, bucket: event.target.value }))} />
                                                        <Input value={userStorage.accessKeyId} placeholder="Access Key ID" onChange={(event) => setUserStorage((value) => ({ ...value, accessKeyId: event.target.value }))} />
                                                        <Input.Password value={userStorage.secretAccessKey} placeholder="Secret Access Key" onChange={(event) => setUserStorage((value) => ({ ...value, secretAccessKey: event.target.value }))} />
                                                        <Input value={userStorage.publicBaseUrl} placeholder="公开访问地址，例如 https://pub-xxx.r2.dev" onChange={(event) => setUserStorage((value) => ({ ...value, publicBaseUrl: event.target.value }))} />
                                                        <Input value={userStorage.pathPrefix} placeholder="保存路径前缀，例如 images" onChange={(event) => setUserStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                                    </div>
                                                ) : null}
                                            </section>
                                            <section className="mb-5 mt-4 rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-stone-800 dark:bg-stone-900/50">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div>
                                                        <div className="text-sm font-medium">WebDAV 存储</div>
                                                        <div className="mt-1 text-xs text-stone-500">
                                                            开启后，新生成图片和媒体文件会优先保存到你的 WebDAV。
                                                            {webDAVStorageUsageText ? <>当前容量：{webDAVStorageUsageText}</> : null}
                                                        </div>
                                                    </div>
                                                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                                                        <Button size="small" loading={measuringStorageType === "webdav"} onClick={() => void measureStorage(userWebDAVStorage)}>
                                                            统计容量
                                                        </Button>
                                                        <span className="text-xs text-stone-500">自动同步</span>
                                                        <Switch size="small" checked={config.syncWebDAVStorageConfig} onChange={(checked) => updateConfig("syncWebDAVStorageConfig", checked)} />
                                                        <Switch checked={userWebDAVStorage.enabled} disabled={userStorage.enabled} onChange={(enabled) => setUserWebDAVStorage((value) => ({ ...value, enabled }))} />
                                                    </div>
                                                </div>
                                                {userWebDAVStorage.enabled ? (
                                                    <div className="mt-3 grid gap-3 md:grid-cols-2">
                                                        <Input value={userWebDAVStorage.name} placeholder="配置名称" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, name: event.target.value }))} />
                                                        <Input value={userWebDAVStorage.endpoint} placeholder="WebDAV 地址" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, endpoint: event.target.value }))} />
                                                        <Input value={userWebDAVStorage.pathPrefix} placeholder="远程目录" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, pathPrefix: event.target.value }))} />
                                                        <Input value={userWebDAVStorage.username} placeholder="用户名" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, username: event.target.value }))} />
                                                        <Input.Password value={userWebDAVStorage.password} placeholder="密码 / 应用密码" onChange={(event) => setUserWebDAVStorage((value) => ({ ...value, password: event.target.value }))} />
                                                    </div>
                                                ) : null}
                                            </section>
                                        </>
                                    ) : null}
                                    {(!isMimoTtsModel(config.audioModel) || isMimoPresetTtsModel(config.audioModel) || isMimoVoiceCloneModel(config.audioModel)) && !glmTts && !grokTts && !miniMaxTts ? (
                                        <Form.Item label="默认音频指令" className="mb-4">
                                            <Input.TextArea rows={2} value={config.audioInstructions} placeholder="例如：自然、温暖、适合旁白。" onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                        </Form.Item>
                                    ) : null}
                                    <Form.Item label="系统提示词" className="mb-4">
                                        <Input.TextArea rows={3} value={config.systemPrompt} placeholder="例如：你是一位擅长电影感写实摄影的视觉导演。" onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                    </Form.Item>
                                    {legacyTokenSettings ? <Form.Item label="手动填写令牌（高级）" className="mb-0">
                                        <FitManualKeyField />
                                    </Form.Item> : null}
                                    </>
                                ),
                            },
                        ]}
                    />
                </Form>
            </div>
        </Modal>
    );
}

function FeatureSwitch({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
            <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">{title}</div>
                <Switch checked={checked} onChange={onChange} />
            </div>
            <div className="mt-1 text-xs leading-5 text-stone-500">{description}</div>
        </div>
    );
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
