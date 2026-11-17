"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { App } from "antd";

import { FIT_ACCOUNT_RECHECK_MS, FIT_BRIDGE_READY_TIMEOUT_MS, FIT_BRIDGE_URL, accountSwitchText, bridgeOpening, needsCanvasLogin, parseBridgeMessage, shouldMountBridge, type BridgeMountInput } from "@/lib/fit-bridge";
import { fitKeysComplete, hasBridgeFitKeys } from "@/lib/fit-config";
import { FIT_ORIGIN } from "@/lib/model-channel";
import { useConfigStore } from "@/stores/use-config-store";
import { attachFitBridge, detachFitBridge, receiveFitBridgeMessage, useFitBridgeStore } from "@/stores/use-fit-bridge-store";
import { useUserStore } from "@/stores/use-user-store";

/**
 * 页面里隐藏的 openai.fit 桥接页：用户已登录 openai.fit 时静默登录画布、取三把令牌；令牌是它取的，每次打开页面再 ping 一下，fit 退出了就清掉。
 * 只在需要时挂载（见 shouldMountBridge / bridgeOpening），只收 origin 是 https://openai.fit、source 是这个 iframe 的消息，发消息的 targetOrigin 写死 https://openai.fit。
 * sandbox 带 allow-same-origin：不带的话桥接页的源是 null，openai.fit 会拒绝它的 refresh 请求，登录 cookie 也带不上；sandbox 禁止它跳转顶层页面、弹窗和提交表单。
 * fit 换了人、静默登录前本机有没同步过的画布项目：都弹窗先问。
 */
export function FitBridge() {
    const { message, modal } = App.useApp();
    const pathname = usePathname() || "";
    const frameRef = useRef<HTMLIFrameElement>(null);
    // 只在浏览器里、读过「不要自动登录」标记之后才决定挂不挂：服务端渲染和首帧不放 iframe（不然标记还没读到就先加载了桥接页）
    const [started, setStarted] = useState(false);
    const fitLogin = useConfigStore((state) => state.publicSettings?.auth?.fitLogin === true);
    const keysComplete = useConfigStore((state) => fitKeysComplete(state.config));
    const bridgeKeys = useConfigStore((state) => hasBridgeFitKeys(state.config));
    const accountCheckedAt = useConfigStore((state) => state.config.fitAccount?.checkedAt || 0);
    const configOpen = useConfigStore((state) => state.isConfigOpen);
    const userReady = useUserStore((state) => state.isReady);
    const userToken = useUserStore((state) => state.token);
    const autoLoginOff = useFitBridgeStore((state) => state.autoLoginOff);
    const pendingSignIn = useFitBridgeStore((state) => state.pendingSignIn);
    const keysChecked = useFitBridgeStore((state) => state.keysChecked);
    const presenceChecked = useFitBridgeStore((state) => state.presenceChecked);
    const frameKey = useFitBridgeStore((state) => state.frameKey);
    const connection = useFitBridgeStore((state) => state.connection);
    const accountSwitch = useFitBridgeStore((state) => state.accountSwitch);
    const projectConsent = useFitBridgeStore((state) => state.projectConsent);
    const needsLogin = needsCanvasLogin({ pathname, fitLogin, userReady, userToken });
    const input: BridgeMountInput = { pathname, autoLoginOff, fitLogin, userReady, userToken, keysComplete, keysChecked, configOpen, pendingSignIn, presencePending: bridgeKeys && !presenceChecked, accountStale: Date.now() - accountCheckedAt > FIT_ACCOUNT_RECHECK_MS };
    const mount = started && shouldMountBridge(input);
    const opening = bridgeOpening(input);
    const openingRef = useRef(opening);

    useEffect(() => {
        openingRef.current = opening;
    }, [opening]);

    useEffect(() => {
        useFitBridgeStore.getState().init((type, text) => void message[type](text));
        setStarted(true);
    }, [message]);

    useEffect(() => {
        const store = useFitBridgeStore.getState();
        if (!mount) {
            store.setConnection("idle");
            return;
        }
        store.setConnection("connecting");
        const readyTimer = setTimeout(() => {
            if (useFitBridgeStore.getState().connection !== "connecting") return;
            useFitBridgeStore.getState().setConnection("unavailable");
            // 连不上就算这次打开页面核对过了：只为 ping 挂着的桥接页卸掉，不在每个页面里一直挂着
            useFitBridgeStore.setState({ presenceChecked: true });
        }, FIT_BRIDGE_READY_TIMEOUT_MS);
        const onMessage = (event: MessageEvent) => {
            const frame = frameRef.current?.contentWindow;
            const incoming = parseBridgeMessage(event, frame);
            if (!incoming || !frame) return;
            if (incoming.kind !== "ready") return receiveFitBridgeMessage(incoming);
            clearTimeout(readyTimer);
            attachFitBridge((payload) => frame.postMessage(payload, FIT_ORIGIN));
            useFitBridgeStore.getState().setConnection("ready");
            // 只为核对 fit 还登录着没就 ping（不发 fit 请求），其余发 hello
            if (openingRef.current === "ping") void useFitBridgeStore.getState().checkPresence();
            else void useFitBridgeStore.getState().probe();
        };
        window.addEventListener("message", onMessage);
        return () => {
            clearTimeout(readyTimer);
            window.removeEventListener("message", onMessage);
            detachFitBridge();
        };
    }, [mount, frameKey]);

    // 去 openai.fit 登录后回到这里（窗口重新获得焦点、页面重新可见）再问一次；没登录时桥接页只读一下 cookie，不发请求
    useEffect(() => {
        const recheck = () => {
            if (document.visibilityState === "hidden") return;
            const { fitLoggedIn, pendingSignIn: waiting, autoLoginOff: off, probe } = useFitBridgeStore.getState();
            if (!off && (fitLoggedIn === false || waiting)) void probe();
        };
        window.addEventListener("focus", recheck);
        document.addEventListener("visibilitychange", recheck);
        return () => {
            window.removeEventListener("focus", recheck);
            document.removeEventListener("visibilitychange", recheck);
        };
    }, []);

    // 设置弹窗打开时令牌列表超过 60 秒就刷新一次；画布后来才需要登录（设置读完、登录状态查完）时补一次带登录请求的 hello
    useEffect(() => {
        // 点过「退出登录」（不要自动连接）时桥接页只为 ping 挂着，不发 hello
        if (connection !== "ready" || useFitBridgeStore.getState().autoLoginOff) return;
        const { statusAt, probe } = useFitBridgeStore.getState();
        if ((configOpen && Date.now() - statusAt > 60_000) || needsLogin) void probe();
    }, [configOpen, connection, needsLogin]);

    // openai.fit 换了人：原账号的令牌已经清掉，新账号的令牌和画布账号等用户点头
    useEffect(() => {
        if (!accountSwitch) return;
        const dialog = modal.confirm({
            title: "openai.fit 换了账号",
            content: accountSwitchText(accountSwitch),
            okText: `改用「${accountSwitch.to.displayName}」`,
            cancelText: "不用",
            onOk: () => useFitBridgeStore.getState().confirmAccountSwitch(),
            onCancel: () => useFitBridgeStore.getState().declineAccountSwitch(),
        });
        return () => dialog.destroy();
    }, [accountSwitch, modal]);

    // 静默登录画布之前：本机的画布项目没同步过这个 fit 账号，登录后会同步进去，先问
    useEffect(() => {
        if (!projectConsent) return;
        const name = projectConsent.fitUser.displayName;
        const dialog = modal.confirm({
            title: "用 openai.fit 账号登录画布？",
            content: `openai.fit 现在登录的是「${name}」。本机浏览器里有 ${projectConsent.projects} 个画布项目，登录画布后会同步到「${name}」的画布账号，这个账号能看到它们。确认是你自己的账号吗？`,
            okText: "是我的，登录并同步",
            cancelText: "不是，先不登录",
            onOk: () => useFitBridgeStore.getState().confirmProjectSync(),
            onCancel: () => useFitBridgeStore.getState().declineProjectSync(),
        });
        return () => dialog.destroy();
    }, [projectConsent, modal]);

    if (!mount) return null;
    return <iframe key={frameKey} ref={frameRef} src={FIT_BRIDGE_URL} title="openai.fit" hidden aria-hidden tabIndex={-1} sandbox="allow-scripts allow-same-origin" />;
}
