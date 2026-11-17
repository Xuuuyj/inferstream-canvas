"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

import { AppTopNav } from "@/components/layout/app-top-nav";
import { canvasProjectsOwner, writeCanvasProjectsOwner } from "@/lib/fit-bridge";
import { fetchUserConfig } from "@/services/api/user-config";
import { startInferStreamLogin } from "@/lib/inferstream-login";
import { useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

const protectedPrefixes = ["/asset-library"];

export default function UserLayout({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const router = useRouter();
    const user = useUserStore((state) => state.user);
    const isReady = useUserStore((state) => state.isReady);
    const inferStreamLogin = useConfigStore((state) => state.publicSettings?.auth?.inferStreamLogin === true);
    const wasLoggedOutRef = useRef(false);
    const isProtectedPage = protectedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

    useEffect(() => {
        if (!inferStreamLogin || !isReady || user || pathname === "/auth/inferstream" || isProtectedPage) return;
        const current = window.location;
        const redirect = pathname === "/login"
            ? new URLSearchParams(current.search).get("redirect") ?? "/"
            : current.pathname + current.search + current.hash;
        void startInferStreamLogin(redirect, true).catch(() => {});
    }, [inferStreamLogin, isProtectedPage, isReady, pathname, user]);

    useEffect(() => {
        if (!isReady || !isProtectedPage || user) return;
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }, [isProtectedPage, isReady, pathname, router, user]);

    useEffect(() => {
        if (!isReady) return;
        if (!user) {
            wasLoggedOutRef.current = true;
            return;
        }
        const syncCanvasAfterLogin = wasLoggedOutRef.current;
        const token = useUserStore.getState().token;
        if (!token) return;
        wasLoggedOutRef.current = false;
        fetchUserConfig(token).then(async (config) => {
            const syncEnabled = config.syncCapabilities?.userData === true;
            const { useCanvasStore } = await import("@/app/(user)/canvas/stores/use-canvas-store");
            const canvasStore = useCanvasStore.getState();
            canvasStore.setSyncEnabled(syncEnabled);
            if (
                syncCanvasAfterLogin &&
                syncEnabled &&
                canvasStore.hydrated
            ) {
                // 记下本机画布项目同步到了哪个账号：之后用别的 openai.fit 账号静默登录前要先问（见 use-fit-bridge-store）
                writeCanvasProjectsOwner(canvasProjectsOwner(user));
                void canvasStore.syncWithRemote(token, true);
            }
            const { useAssetStore } = await import("@/stores/use-asset-store");
            void useAssetStore.getState().hydrateAccountAssets(token, syncEnabled);
        }).catch(() => { });
    }, [isReady, user]);

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <AppTopNav />
            <div className="min-h-0 flex-1 overflow-hidden">{isProtectedPage && (!isReady || !user) ? null : children}</div>
        </div>
    );
}
