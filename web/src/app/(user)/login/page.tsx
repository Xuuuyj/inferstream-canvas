"use client";

import { App, Button } from "antd";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";

import { SiteCredits } from "@/components/layout/github-link";
import { startInferStreamLogin } from "@/lib/inferstream-login";
import { useConfigStore } from "@/stores/use-config-store";

export default function LoginPage() {
    return (
        <main className="flex h-full min-h-0 flex-col items-center overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-10 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
            <section className="my-auto w-full max-w-[420px] py-8">
                <div className="mb-7 text-center">
                    <span
                        className="mx-auto mb-4 block size-12 bg-stone-950 dark:bg-stone-100"
                        style={{
                            mask: "url(/logo.svg) center / contain no-repeat",
                            WebkitMask: "url(/logo.svg) center / contain no-repeat",
                        }}
                        role="img" aria-label="InferStream 无限画布"
                    />
                    <h1 className="text-3xl font-semibold tracking-normal text-stone-950 dark:text-stone-100">账号登录</h1>
                    <p className="mt-3 text-base leading-7 text-stone-500 dark:text-stone-400">登录后可同步画布项目和设置。</p>
                </div>
                <Suspense fallback={<Button type="primary" block size="large" loading>使用 InferStream 登录</Button>}>
                    <InferStreamLoginButton />
                </Suspense>
            </section>
            <SiteCredits className="shrink-0" />
        </main>
    );
}

function InferStreamLoginButton() {
    const { message } = App.useApp();
    const searchParams = useSearchParams();
    const settings = useConfigStore((state) => state.publicSettings);
    const [starting, setStarting] = useState(false);

    const connect = async () => {
        setStarting(true);
        try {
            await startInferStreamLogin(searchParams.get("redirect") ?? "/");
        } catch {
            setStarting(false);
            message.error("无法开始 InferStream 登录，请重试。");
        }
    };

    return (
        <>
            <Button type="primary" block size="large" loading={starting} disabled={settings?.auth?.inferStreamLogin !== true} onClick={() => void connect()}>
                使用 InferStream 登录
            </Button>
            {settings && settings.auth?.inferStreamLogin !== true ? (
                <p role="status" className="mt-3 text-center text-sm text-stone-500">InferStream 登录暂不可用。</p>
            ) : null}
        </>
    );
}
