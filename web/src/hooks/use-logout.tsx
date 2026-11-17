"use client";

import { useQueryClient } from "@tanstack/react-query";
import { App, Button } from "antd";

import { saveInferStreamImageToken } from "@/lib/inferstream-image-access";
import { disableInferStreamAutoLogin } from "@/lib/inferstream-login";
import { logoutAsksAboutFitToken } from "@/lib/fit-config";
import { useConfigStore } from "@/stores/use-config-store";
import { useFitBridgeStore } from "@/stores/use-fit-bridge-store";
import { useUserStore } from "@/stores/use-user-store";

/**
 * 主动点「退出登录」：浏览器里存着 openai.fit 令牌时先问清不清，取消就不退出；没存令牌直接退出。
 * 三种退出都先记下「不要自动登录」（不再挂 openai.fit 桥接页，不会马上又自动登录回来），直到用户再点「用 openai.fit 登录」。
 * 登录过期、被动退出和换账号不走这里，令牌照旧保留（client-root-init 只调 resetAccountPreferences）。
 */
export function useLogout() {
    const { modal } = App.useApp();
    const queryClient = useQueryClient();
    const clearUserSession = useUserStore((state) => state.clearSession);
    const clearSession = () => {
        disableInferStreamAutoLogin();
        const userId = useUserStore.getState().user?.id;
        if (userId) saveInferStreamImageToken(userId, "");
        clearUserSession();
    };
    const clearFitKeys = useConfigStore((state) => state.clearFitKeys);
    const disableAutoLogin = useFitBridgeStore((state) => state.disableAutoLogin);
    const forgetFitSession = useFitBridgeStore((state) => state.forgetFitSession);

    return () => {
        if (!logoutAsksAboutFitToken(useConfigStore.getState().config)) {
            disableAutoLogin();
            return clearSession();
        }
        const dialog = modal.confirm({
            title: "退出登录",
            content: "这个浏览器还保存着旧的模型服务令牌。只退出的话，别人用这台电脑仍能用它生成、扣你的额度；公用电脑请一起清除。",
            okText: "退出并清除令牌",
            cancelText: "取消",
            onOk: () => {
                disableAutoLogin();
                clearFitKeys();
                forgetFitSession();
                queryClient.removeQueries({ queryKey: ["fit-studio"] });
                clearSession();
            },
            footer: (_, { OkBtn, CancelBtn }) => (
                <>
                    <CancelBtn />
                    <Button
                        onClick={() => {
                            dialog.destroy();
                            disableAutoLogin();
                            clearSession();
                        }}
                    >
                        仅退出（保留令牌）
                    </Button>
                    <OkBtn />
                </>
            ),
        });
    };
}
