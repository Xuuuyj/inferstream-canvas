"use client";

import { Button } from "antd";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { localCanvasProjectCount } from "@/lib/canvas-local-projects";
import { readCanvasProjectsOwner, canvasProjectsOwner } from "@/lib/fit-bridge";
import { consumeInferStreamLogin, safeCanvasReturn } from "@/lib/inferstream-login";
import { loginWithInferStream, type AuthSession } from "@/services/api/auth";
import { useUserStore } from "@/stores/use-user-store";

export default function InferStreamCallback() {
    const router = useRouter();
    const started = useRef(false);
    const [consent, setConsent] = useState<{ session: AuthSession; redirect: string }>();
    const [failure, setFailure] = useState(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        async function complete() {
            const query = new URLSearchParams(window.location.search);
            window.history.replaceState(null, "", window.location.pathname);
            const request = consumeInferStreamLogin(query.get("state") ?? "");
            if (!request) throw new Error("invalid state");
            const redirect = safeCanvasReturn(request.redirect);
            if (query.get("error") === "login_required") {
                router.replace(redirect);
                return;
            }
            const code = query.get("code");
            if (!code) throw new Error("missing authorization");
            const session = await loginWithInferStream({ code, codeVerifier: request.verifier, state: request.state });
            const needsSyncConsent = request.silent === true
                && await localCanvasProjectCount() > 0
                && readCanvasProjectsOwner() !== canvasProjectsOwner(session.user);
            if (request.silent !== true || needsSyncConsent) {
                setConsent({ session, redirect });
                return;
            }
            useUserStore.getState().setSession(session.token, session.user);
            router.replace(redirect);
        }
        void complete().catch(() => setFailure(true));
    }, [router]);

    function finishLogin(canvasSyncDisabled: boolean) {
        if (!consent) return;
        useUserStore.getState().setSession(consent.session.token, consent.session.user, canvasSyncDisabled);
        router.replace(consent.redirect);
    }

    return (
        <main className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            {consent ? (
                <>
                    <p>以 InferStream 账号 {consent.session.user.displayName || consent.session.user.username} 登录时，是否同步画布项目？</p>
                    <p className="text-muted-foreground">仅登录时，画布项目保存在当前浏览器。</p>
                    <div className="flex w-full max-w-56 flex-col gap-4">
                        <Button block type="primary" onClick={() => finishLogin(false)}>登录并同步</Button>
                        <Button block onClick={() => finishLogin(true)}>仅登录，不同步画布</Button>
                        <Button block onClick={() => router.replace(consent.redirect)}>取消</Button>
                    </div>
                </>
            ) : failure ? (
                <>
                    <p>InferStream 登录未完成。</p>
                    <Button href="/login">返回登录页</Button>
                </>
            ) : <p>正在连接 InferStream…</p>}
        </main>
    );
}
