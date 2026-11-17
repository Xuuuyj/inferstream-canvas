"use client";

import { useQuery } from "@tanstack/react-query";
import { fitKeyFor } from "@/lib/fit-config";
import type { ModelProfile } from "@/lib/fit-generate/types";
import { loadFitStudio } from "@/services/api/fit/catalog";
import { useConfigStore } from "@/stores/use-config-store";

/** 当前三把 openai.fit 令牌下这个图片/视频模型的 fit 表单契约，给参数面板用；没令牌、没给模型、还在加载、加载失败或不是图片/视频模型时为 null（没给模型时不发请求）。 */
export function useFitProfile(model?: string): ModelProfile | null {
    const video = useConfigStore((state) => fitKeyFor(state.config, "video"));
    const image = useConfigStore((state) => fitKeyFor(state.config, "image"));
    const text = useConfigStore((state) => fitKeyFor(state.config, "text"));
    const { data } = useQuery({ queryKey: ["fit-studio", video, image, text], queryFn: () => loadFitStudio({ video, image, text }), enabled: Boolean((video || image || text) && model), staleTime: 60_000 });
    return (model && data && Object.hasOwn(data.profiles, model) && data.profiles[model]) || null;
}
