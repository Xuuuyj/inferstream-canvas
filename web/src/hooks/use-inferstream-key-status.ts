"use client";

import { useEffect, useState } from "react";

import { INFERSTREAM_TOKENS_EVENT, inferStreamKeyStatus, inferStreamTokenLabel } from "@/lib/inferstream-image-access";
import { useUserStore } from "@/stores/use-user-store";

/** InferStream 模式下顶栏钥匙按钮的字和提示；Key 存在 localStorage，靠事件（本页）和 storage（别的标签页）刷新。 */
export function useInferStreamKeyStatus(enabled: boolean) {
    const userId = useUserStore((state) => state.user?.id);
    const [labels, setLabels] = useState({ image: "", video: "" });
    useEffect(() => {
        if (!enabled) return;
        const refresh = () => setLabels({ image: inferStreamTokenLabel("image", userId), video: inferStreamTokenLabel("video", userId) });
        refresh();
        window.addEventListener(INFERSTREAM_TOKENS_EVENT, refresh);
        window.addEventListener("storage", refresh);
        return () => {
            window.removeEventListener(INFERSTREAM_TOKENS_EVENT, refresh);
            window.removeEventListener("storage", refresh);
        };
    }, [enabled, userId]);
    return inferStreamKeyStatus(labels.image, labels.video);
}
