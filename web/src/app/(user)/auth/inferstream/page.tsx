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
            if (await localCanvasProjectCount() > 0 && readCanvasProjectsOwner() !== canvasProjectsOwner(session.user)) {
                setConsent({ session, redirect });
                return;
            }
            useUserStore.getState().setSession(session.token, session.user);
            router.replace(redirect);
        }
        void complete().catch(() => setFailure(true));
    }, [router]);

    return (
        <main className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
            {consent ? (
                <>
                    <p>此浏览器还有画布项目。是否将它们同步到 InferStream 账号 {consent.session.user.displayName || consent.session.user.username}？</p>
                    <Button type="primary" onClick={() => {
                        useUserStore.getState().setSession(consent.session.token, consent.session.user);
                        router.replace(consent.redirect);
                    }}>登录并同步</Button>
                    <Button onClick={() => router.replace(consent.redirect)}>取消</Button>
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
