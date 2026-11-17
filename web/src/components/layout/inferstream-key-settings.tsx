"use client";

import { App, Button, Input, Select } from "antd";
import { useCallback, useEffect, useState } from "react";

import {
    accountKeyAllows,
    importInferStreamAccountKey,
    inferStreamImageModel,
    inferStreamTokenLabel,
    inferStreamVideoModels,
    listInferStreamAccountKeys,
    saveInferStreamToken,
    verifyInferStreamToken,
    type InferStreamAccountKey,
    type InferStreamCapability,
} from "@/lib/inferstream-image-access";

const rows: { capability: InferStreamCapability; title: string; hint: string }[] = [
    { capability: "image", title: `图片生成 · ${inferStreamImageModel}`, hint: "生图和参考图编辑用这把 Key 计费。" },
    { capability: "video", title: `视频生成 · ${Object.keys(inferStreamVideoModels).join("、")}`, hint: "视频按次计费，生成失败由 InferStream 退还。" },
];

/** InferStream 模式下图片、视频各选一把 Key：从账号导入或手动粘贴，只存在当前浏览器。 */
export function InferStreamKeySettings({ userId, open }: { userId: string; open: boolean }) {
    const { message } = App.useApp();
    const [keys, setKeys] = useState<InferStreamAccountKey[] | null>(null);
    const [keysError, setKeysError] = useState("");
    const [labels, setLabels] = useState<Record<InferStreamCapability, string>>({ image: "", video: "" });
    const [inputs, setInputs] = useState<Record<InferStreamCapability, string>>({ image: "", video: "" });
    const [busy, setBusy] = useState<InferStreamCapability | null>(null);

    const refreshLabels = useCallback(() => setLabels({ image: inferStreamTokenLabel("image", userId), video: inferStreamTokenLabel("video", userId) }), [userId]);

    const loadKeys = useCallback(async () => {
        setKeysError("");
        try {
            setKeys(await listInferStreamAccountKeys());
        } catch (error) {
            setKeys([]);
            setKeysError(error instanceof Error ? error.message : "读取 InferStream Key 失败。");
        }
    }, []);

    useEffect(() => {
        if (!open) return;
        refreshLabels();
        setInputs({ image: "", video: "" });
        void loadKeys();
    }, [open, refreshLabels, loadKeys]);

    const run = async (capability: InferStreamCapability, action: () => Promise<void>, success: string) => {
        if (busy) return;
        setBusy(capability);
        try {
            await action();
            refreshLabels();
            message.success(success);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "连接 InferStream 失败。");
        } finally {
            setBusy(null);
        }
    };

    const importKey = (capability: InferStreamCapability, id: number) => {
        const key = keys?.find((item) => item.id === id);
        if (!key) return;
        void run(capability, () => importInferStreamAccountKey(capability, userId, key), `已用「${key.name}」连接${capability === "image" ? "生图" : "视频"}。`);
    };

    const connectManual = (capability: InferStreamCapability) => {
        const value = inputs[capability].trim();
        if (!value) return;
        void run(
            capability,
            async () => {
                await verifyInferStreamToken(capability, value);
                saveInferStreamToken(capability, userId, value);
                setInputs((current) => ({ ...current, [capability]: "" }));
            },
            `InferStream ${capability === "image" ? "生图" : "视频"}已连接。`,
        );
    };

    return (
        <div className="space-y-3">
            {keysError ? <div className="text-xs text-amber-600 dark:text-amber-400">{keysError}</div> : null}
            {rows.map(({ capability, title, hint }) => {
                const usable = (keys ?? []).filter((key) => accountKeyAllows(key, capability));
                return (
                    <div key={capability} className="space-y-1.5">
                        <div className="text-sm">
                            {title}
                            {labels[capability] ? <span className="text-stone-500"> · 已连接：{labels[capability]}</span> : <span className="text-stone-500"> · 未连接</span>}
                        </div>
                        <div className="text-xs text-stone-500">{hint}</div>
                        <div className="flex flex-wrap gap-2">
                            <Select
                                className="min-w-56 flex-1"
                                aria-label={`选择${capability === "image" ? "生图" : "视频"}用的 InferStream Key`}
                                placeholder={keys === null ? "正在读取账号里的 Key…" : usable.length ? "从 InferStream 账号选择 Key" : "账号里没有可用的 Key"}
                                loading={keys === null}
                                disabled={busy !== null || !usable.length}
                                value={null}
                                options={usable.map((key) => ({ value: key.id, label: `${key.name}（${key.key_hint}）${key.org_id ? " · 组织" : ""}` }))}
                                onChange={(id: number) => importKey(capability, id)}
                            />
                            {labels[capability] ? (
                                <Button
                                    disabled={busy !== null}
                                    onClick={() => {
                                        saveInferStreamToken(capability, userId, "");
                                        refreshLabels();
                                    }}
                                >
                                    断开
                                </Button>
                            ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <Input.Password
                                className="min-w-56 flex-1"
                                aria-label={`手动粘贴${capability === "image" ? "生图" : "视频"}用的 InferStream API Key`}
                                placeholder="或手动粘贴 API Key"
                                autoComplete="off"
                                value={inputs[capability]}
                                onChange={(event) => setInputs((current) => ({ ...current, [capability]: event.target.value }))}
                            />
                            <Button loading={busy === capability} disabled={!inputs[capability].trim() || (busy !== null && busy !== capability)} onClick={() => connectManual(capability)}>
                                验证并连接
                            </Button>
                        </div>
                    </div>
                );
            })}
            <div className="flex flex-wrap gap-3 text-sm">
                <a className="underline" href={`${"https://www.inferstream.cn"}/console/api-keys`} target="_blank" rel="noreferrer">
                    管理 InferStream API Key
                </a>
                <button type="button" className="cursor-pointer underline" onClick={() => void loadKeys()}>
                    重新读取账号 Key
                </button>
            </div>
        </div>
    );
}
