"use client";

import { Code2 } from "lucide-react";

import { FOOTER_LINKS, LICENSE_URL, SOURCE_URL, UPSTREAM_PROJECT } from "@/constant/promo";
import { cn } from "@/lib/utils";

type GitHubLinkProps = {
    className?: string;
    style?: React.CSSProperties;
};

// 源代码入口（AGPL-3.0 第 13 条），沿用 GitHubLink 导出名，顶栏、画布工具栏和后台页头一起生效。
export function GitHubLink({ className, style }: GitHubLinkProps) {
    return (
        <a
            className={cn("inline-flex size-9 shrink-0 items-center justify-center rounded-full text-stone-600 transition hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-white", className)}
            style={style}
            href={SOURCE_URL}
            target="_blank"
            rel="noreferrer"
            aria-label="源代码（AGPL-3.0）"
            title="源代码（AGPL-3.0）"
        >
            <Code2 className="size-4" />
        </a>
    );
}

// 首页和登录页的站点与开源署名。
export function SiteCredits({ className }: { className?: string }) {
    const link = (label: string, href: string) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-2 transition hover:text-stone-700 hover:underline dark:hover:text-stone-200">
            {label}
        </a>
    );
    const items = [
        "InferStream 无限画布",
        <>基于 {link(UPSTREAM_PROJECT.label, UPSTREAM_PROJECT.url)} 修改</>,
        link("AGPL-3.0", LICENSE_URL),
        link("源代码", SOURCE_URL),
        ...FOOTER_LINKS.map((item) => link(item.label, item.url)),
    ];
    return (
        <p className={cn("flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-xs leading-5 text-stone-400 dark:text-stone-500", className)}>
            {items.map((item, index) => (
                <span key={index} className="inline-flex items-center gap-2">
                    {index ? <span aria-hidden>·</span> : null}
                    {item}
                </span>
            ))}
        </p>
    );
}
