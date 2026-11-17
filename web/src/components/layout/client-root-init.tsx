"use client";

import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { App, Typography } from "antd";

import { FitBridge } from "@/components/layout/fit-bridge";
import { fitModelsStale, normalizeFitApiKey, resetAccountPreferences, syncedPreferences } from "@/lib/fit-config";
import { fitTokenLinkWarning, maskFitApiKey, parseFitTokenLink } from "@/lib/fit-token-link";
import { fetchFitTokenInfo } from "@/services/api/fit/token";
import { fetchUserConfig } from "@/services/api/user-config";
import { replaceWorkflowChannels } from "@/services/workflow-channel-storage";
import { STORAGE_SYNC_FAILED_EVENT, defaultUserStorageProvider, defaultUserWebDAVStorageProvider, saveUserStorageProvider, saveUserWebDAVStorageProvider } from "@/services/image-storage";
import { defaultConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";
import { useFitBridgeStore } from "@/stores/use-fit-bridge-store";
import { useUserStore } from "@/stores/use-user-store";

export function ClientRootInit({ children }: { children: ReactNode }) {
    const { message, modal } = App.useApp();
    const handledConfigParams = useRef(false);
    const pathname = usePathname();
    const token = useUserStore((state) => state.token);
    const user = useUserStore((state) => state.user);
    const hydrateUser = useUserStore((state) => state.hydrateUser);
    const publicSettings = useConfigStore((state) => state.publicSettings);
    const legacyTokenSettings = publicSettings !== null && publicSettings.auth?.inferStreamLogin !== true;
    const loadPublicSettings = useConfigStore((state) => state.loadPublicSettings);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const setFitManualKey = useConfigStore((state) => state.setFitManualKey);
    const refreshFitModels = useConfigStore((state) => state.refreshFitModels);
    const isLoginPage = pathname === "/login" || pathname === "/admin/login";
    const accountSessionRef = useRef({ token, userId: user?.id || "" });

    useEffect(() => {
        const onSyncFailed = (event: Event) => {
            const detail = (event as CustomEvent<string>).detail;
            message.warning({ key: STORAGE_SYNC_FAILED_EVENT, content: `云端同步失败，已保留原始素材${detail ? `：${detail}` : ""}` });
        };
        window.addEventListener(STORAGE_SYNC_FAILED_EVENT, onSyncFailed);
        return () => window.removeEventListener(STORAGE_SYNC_FAILED_EVENT, onSyncFailed);
    }, [message]);

    useEffect(() => {
        void loadPublicSettings();
    }, [loadPublicSettings]);

    // openai.fit 上新、下架的模型跟着变：打开页面、切回标签页时，上次同步已超过 10 分钟就静默重拉（失败照旧用上次的列表）
    useEffect(() => {
        if (!legacyTokenSettings) return;
        const refreshIfStale = () => {
            if (document.visibilityState === "visible" && fitModelsStale(useConfigStore.getState().config)) void refreshFitModels().catch(() => undefined);
        };
        refreshIfStale();
        document.addEventListener("visibilitychange", refreshIfStale);
        return () => document.removeEventListener("visibilitychange", refreshIfStale);
    }, [legacyTokenSettings, refreshFitModels]);

    useEffect(() => {
        if (!isLoginPage) void hydrateUser();
    }, [hydrateUser, isLoginPage]);

	useLayoutEffect(() => {
		const previous = accountSessionRef.current;
		const userId = user?.id || "";
		if ((previous.token && !token) || (previous.userId && userId && previous.userId !== userId)) {
			// 退出、过期或 /auth/me 失败：令牌、渠道和模型列表是浏览器级设置，保留；只重置随账号同步的偏好。
			useConfigStore.setState((state) => ({ config: resetAccountPreferences(state.config, defaultConfig) }));
		} else {
			updateConfig("workflowSyncTouched", false);
		}
		accountSessionRef.current = { token, userId };
	}, [token, updateConfig, user?.id]);

	useEffect(() => {
        if (!token || !user?.id) return;
        const accountToken = token;
        const accountId = user.id;
        let canceled = false;
		void fetchUserConfig(accountToken)
			.then(async (payload) => {
				if (canceled || useUserStore.getState().token !== accountToken || useUserStore.getState().user?.id !== accountId) return;
				let workflowsReady = true;
				const syncS3 = payload.modelConfig?.syncStorageConfig === true;
                const syncWebDAV = payload.modelConfig?.syncWebDAVStorageConfig === true;
                if (payload.modelConfig) {
                    const { workflowChannels, ...modelConfig } = payload.modelConfig;
					if (workflowChannels !== undefined) {
						try {
							await replaceWorkflowChannels(accountId, workflowChannels);
						} catch {
							workflowsReady = false;
						}
					}
                    if (canceled || useUserStore.getState().token !== accountToken || useUserStore.getState().user?.id !== accountId) return;
					Object.entries(syncedPreferences(modelConfig))
						.forEach(([key, value]) => updateConfig(key as keyof AiConfig, value as never));
				}
				updateConfig("workflowSyncTouched", workflowsReady);
				updateConfig("syncStorageConfig", syncS3);
                updateConfig("syncWebDAVStorageConfig", syncWebDAV);
                if (syncS3 && payload.storageProvider?.s3) {
                    saveUserStorageProvider({
                        ...defaultUserStorageProvider(),
                        ...payload.storageProvider.s3,
                        type: "s3",
                    });
                }
                if (syncWebDAV && payload.storageProvider?.webdav) {
                    saveUserWebDAVStorageProvider({
                        ...defaultUserWebDAVStorageProvider(),
                        ...payload.storageProvider.webdav,
                        type: "webdav",
                    });
                }
            })
            .catch(() => {});
        return () => {
            canceled = true;
        };
    }, [token, updateConfig, user?.id]);

    useEffect(() => {
        if (!publicSettings || handledConfigParams.current) return;
        const link = parseFitTokenLink(window.location.href);
        if (!link) return;
        handledConfigParams.current = true;
        window.history.replaceState(window.history.state, "", link.cleanUrl);
        if (!legacyTokenSettings) {
            message.warning("当前版本不支持从链接导入令牌。");
            return;
        }
        if (link.keyInQuery) {
            message.error({ content: "链接把令牌放在了 ? 参数里，已从地址栏移除，没有导入。请在 openai.fit 令牌列表点「聊天」，用 # 开头的链接（/#apiKey=…）重新进入", duration: 10 });
            return;
        }
        if (!link.apiKey) {
            openConfigDialog(false);
            message.error(link.foreignBaseUrl ? "只支持 openai.fit 令牌" : "链接里没有 openai.fit 令牌");
            return;
        }
        const apiKey = link.apiKey;
        // 链接带的令牌作为手动令牌（高级备用）：视频、图片、文本都用它
        const connect = () => {
            setFitManualKey(apiKey);
            void refreshFitModels()
                .then((result) => {
                    if (result) message.success(`已连接 openai.fit：${result.tokenName || "未命名令牌"}`);
                    else message.warning("验证期间令牌被更换，这次的验证结果没有使用，请在配置里重新验证");
                })
                .catch((error) => {
                    openConfigDialog(false);
                    message.error(error instanceof Error ? error.message : "openai.fit 令牌验证失败");
                });
        };
        const closeLoading = message.loading("正在读取链接中的令牌信息…", 0);
        void fetchFitTokenInfo(apiKey)
            .then((info) => ({ info, error: "" }), (error: unknown) => ({ info: null, error: error instanceof Error ? error.message : "读取令牌信息失败" }))
            .then(({ info, error }) => {
                closeLoading();
                const currentKey = normalizeFitApiKey(useConfigStore.getState().config.fitManualKey);
                const expired = Boolean(info?.expiresAt && info.expiresAt * 1000 < Date.now());
                modal.confirm({
                    title: "使用链接中的 openai.fit 令牌？",
                    content: (
                        <div className="space-y-1">
                            <div>令牌：{maskFitApiKey(apiKey)}</div>
                            {info ? <div>名称：{info.name || "未命名"}</div> : <div>令牌信息读取失败：{error}</div>}
                            {info ? <div>到期：{info.expiresAt ? new Date(info.expiresAt * 1000).toLocaleString("zh-CN", { hour12: false }) : "永不过期"}{expired ? "（已过期）" : ""}</div> : null}
                            <div>确认后视频、图片、文本都用这把令牌（手动令牌），优先于设置里选的三把令牌。</div>
                            <Typography.Text type="danger" className="block">
                                {fitTokenLinkWarning(useFitBridgeStore.getState().fitLoggedIn === true)}
                            </Typography.Text>
                            {currentKey && currentKey !== apiKey ? <div>当前浏览器已保存手动令牌 {maskFitApiKey(currentKey)}，确认后会被替换。</div> : null}
                            {currentKey === apiKey ? <div>和当前浏览器保存的手动令牌相同。</div> : null}
                        </div>
                    ),
                    okText: "使用此令牌",
                    cancelText: currentKey && currentKey !== apiKey ? "保留当前令牌" : "取消",
                    onOk: connect,
                });
            });
    }, [legacyTokenSettings, message, modal, openConfigDialog, publicSettings, refreshFitModels, setFitManualKey]);

    return (
        <>
            {children}
            {legacyTokenSettings ? <FitBridge /> : null}
        </>
    );
}
