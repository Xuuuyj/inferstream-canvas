"use client";

import { ImageOff } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "@/lib/utils";

// 提示词封面：同步来源的封面由本站后端代取（/api/prompts/<id>/cover），滚到才加载；没有封面或原图床已失效时显示占位，
// 不露出破图图标和替代文字。fallback 不传时用默认的灰底图标。
export function PromptCover({ src, alt, className, fallback }: { src: string; alt: string; className?: string; fallback?: ReactNode }) {
    const [failedSrc, setFailedSrc] = useState("");
    if (!src || failedSrc === src) {
        return (
            fallback ?? (
                <span role="img" aria-label={alt} className={cn("grid place-items-center bg-stone-100 text-stone-300 dark:bg-stone-900 dark:text-stone-600", className)}>
                    <ImageOff className="size-6" />
                </span>
            )
        );
    }
    return <img src={src} alt={alt} loading="lazy" decoding="async" onError={() => setFailedSrc(src)} className={className} />;
}
