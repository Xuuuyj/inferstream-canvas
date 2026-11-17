/** 手写垫片，代替 fit 的 web/src/features/pricing/lib/filters.ts；fit 生成库只用到 parseTags，写法与 fit 一致。 */
export function parseTags(tagsString?: string): string[] {
    if (!tagsString) return [];
    return tagsString
        .split(/[,;|\s]+/)
        .map((tag) => tag.trim())
        .filter(Boolean);
}
