"use client";

import { useState, type ReactNode } from "react";
import { App, Button, Input, Select, Typography } from "antd";

import { useLogout } from "@/hooks/use-logout";
import { FIT_SIGN_IN_URL } from "@/lib/fit-bridge";
import { FIT_KIND_LABELS, FIT_KINDS, normalizeFitApiKey } from "@/lib/fit-config";
import { createCandidates, rankTokens, tokenModelCount, type KeySelectContext } from "@/lib/fit-key-select";
import { maskFitApiKey } from "@/lib/fit-token-link";
import { FIT_KEYS_URL } from "@/lib/model-channel";
import { useConfigStore, type FitKind } from "@/stores/use-config-store";
import { useFitBridgeStore } from "@/stores/use-fit-bridge-store";
import { useUserStore } from "@/stores/use-user-store";

/** 设置弹窗的第一块：画布账号和 openai.fit 的登录状态，一行文字加按钮。 */
export function FitAccountSection() {
    const user = useUserStore((state) => state.user);
    const logout = useLogout();
    const bridge = useFitBridgeStore();
    const now = Date.now();
    const row = (text: string, action?: ReactNode, note?: string, danger = false) => (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={danger ? "text-sm text-red-500" : "text-sm"}>{text}</span>
                {action}
            </div>
            {note ? <div className="mt-1 text-xs text-stone-500">{note}</div> : null}
        </div>
    );
    const signIn = (
        <Button size="small" type="primary" href={FIT_SIGN_IN_URL} target="_blank" rel="noopener" onClick={() => bridge.startSignIn()}>
            登录 openai.fit
        </Button>
    );

    if (bridge.autoLoginOff)
        return row(
            "已退出，不会自动连接 openai.fit",
            <Button size="small" type="primary" onClick={() => bridge.enableAutoLogin()}>
                用 openai.fit 登录
            </Button>,
        );
    if (bridge.loginState === "pending") return row("正在用 openai.fit 自动登录…");
    if (user?.fitUserId)
        return row(
            `已用 openai.fit 登录：${user.displayName || user.username}`,
            <Button size="small" onClick={logout}>
                退出登录
            </Button>,
        );
    if (bridge.loginState === "failed")
        return row(
            `自动登录失败：${bridge.loginError}`,
            <Button size="small" onClick={() => bridge.retryLogin()}>
                重试
            </Button>,
            undefined,
            true,
        );
    if (bridge.connection === "unavailable")
        return row(
            "暂时连不上 openai.fit",
            <Button size="small" disabled={bridge.retryBlockedUntil > now} onClick={() => bridge.retry()}>
                重试
            </Button>,
            "也可以在「更多设置 → 手动填写令牌」里粘贴令牌",
        );
    // 重新挂上的桥接页回 status 之前，fitLoggedIn 还是上一次的，先显示「正在连接」
    if (bridge.connection !== "ready" || !bridge.statusFresh || bridge.fitLoggedIn === null)
        return bridge.lastError && bridge.connection === "ready"
            ? row(
                  bridge.lastError,
                  <Button size="small" disabled={bridge.retryBlockedUntil > now} onClick={() => void bridge.probe()}>
                      重试
                  </Button>,
                  undefined,
                  true,
              )
            : row("正在连接 openai.fit…");
    const fitName = bridge.fitLoggedIn ? bridge.fitUser?.displayName || "已登录" : "未登录";
    if (user) return row(`画布账号：${user.displayName || user.username}（用户名密码登录）· openai.fit：${fitName}`, bridge.fitLoggedIn ? undefined : signIn);
    if (!bridge.fitLoggedIn) return row("openai.fit 未登录", signIn, "登录后回到这里会自动继续");
    return row(`openai.fit：${fitName}`, undefined, bridge.codeDisabled ? "画布账号自动登录暂未开放，不影响生成" : undefined);
}

/** 第二块：视频、图片、文本三个令牌下拉框；用手动令牌时换成一条提示。 */
export function FitKeySlots() {
    const manualKey = useConfigStore((state) => normalizeFitApiKey(state.config.fitManualKey));
    const setFitManualKey = useConfigStore((state) => state.setFitManualKey);

    if (manualKey)
        return (
            <div className="space-y-2">
                <div className="text-sm">正在使用手动填写的令牌 {maskFitApiKey(manualKey)}（视频、图片、文本共用）</div>
                <Button
                    size="small"
                    onClick={() => {
                        setFitManualKey("");
                        void useFitBridgeStore.getState().probe();
                    }}
                >
                    改用 openai.fit 令牌（推荐，三类分开选）
                </Button>
            </div>
        );
    return (
        <div className="space-y-3">
            {FIT_KINDS.map((kind) => (
                <FitKeySlotRow key={kind} kind={kind} />
            ))}
            <div className="flex flex-wrap items-center justify-between gap-2">
                <FitModelsRefresh />
                <Typography.Link href={FIT_KEYS_URL} target="_blank" rel="noreferrer" className="ml-auto text-xs">
                    去 openai.fit 管理令牌
                </Typography.Link>
            </div>
        </div>
    );
}

/** 三把令牌的模型列表：显示上次同步时间，可以手动再拉一次（打开页面时超过 10 分钟也会自动拉）。 */
function FitModelsRefresh() {
    const { message } = App.useApp();
    const checkedAt = useConfigStore((state) => state.config.fitTokenCheckedAt);
    const hasKey = useConfigStore((state) => FIT_KINDS.some((kind) => state.config.fitKeys[kind]));
    const refreshFitModels = useConfigStore((state) => state.refreshFitModels);
    const [refreshing, setRefreshing] = useState(false);
    if (!hasKey) return null;

    const refresh = async () => {
        setRefreshing(true);
        try {
            const result = await refreshFitModels();
            if (result) message.success(`模型列表已更新：视频 ${result.counts.video} 个、图片 ${result.counts.image} 个、文本 ${result.counts.text} 个`);
            else message.warning("刷新期间令牌被更换，这次的结果没有使用，请再刷新一次");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "刷新模型列表失败");
        } finally {
            setRefreshing(false);
        }
    };
    return (
        <span className="text-xs text-stone-500">
            模型列表{checkedAt ? `更新于 ${new Date(checkedAt).toLocaleString("zh-CN", { hour12: false })}` : "还没同步"}
            <Button size="small" type="link" loading={refreshing} onClick={() => void refresh()}>
                刷新
            </Button>
        </span>
    );
}

function FitKeySlotRow({ kind }: { kind: FitKind }) {
    const label = FIT_KIND_LABELS[kind];
    const config = useConfigStore((state) => state.config);
    const keyError = useConfigStore((state) => state.fitKeyErrors[kind]);
    const bridge = useFitBridgeStore();
    const [busy, setBusy] = useState(false);
    const [createGroup, setCreateGroup] = useState<string | undefined>();
    const slot = config.fitKeys[kind];
    const ctx: KeySelectContext = { tokens: bridge.tokens, tokensTotal: bridge.tokensTotal, groups: bridge.groups, userGroup: bridge.fitUser?.group || "", byGroup: bridge.byGroup, now: Math.floor(Date.now() / 1000) };
    // 现在这个桥接页回过 status 才能换令牌、建令牌（新挂上的桥接页还没列过令牌，取 key 会被当成无效请求）
    const connected = bridge.connection === "ready" && bridge.statusFresh && bridge.fitLoggedIn === true;
    const usable = rankTokens(kind, ctx);
    const groupDesc = (name: string) => {
        const group = ctx.groups.find((item) => item.name === (name || ctx.userGroup));
        return group ? `${group.desc}（${group.name}）` : name || "默认分组";
    };
    const options = usable.map((token) => ({ value: token.id, label: `${token.name} · ${groupDesc(token.group).replace(/（.*）$/, "")}` }));
    if (slot && !options.some((option) => option.value === slot.tokenId)) options.unshift({ value: slot.tokenId, label: slot.name || "未命名令牌" });
    const run = async (task: () => Promise<void>) => {
        setBusy(true);
        try {
            await task();
        } finally {
            setBusy(false);
        }
    };
    const verified = Boolean(slot && config.fitTokenCheckedAt && !keyError);
    const count = (capability: "video" | "image" | "text" | "audio") => {
        if (verified) return { exact: true, value: (capability === "video" ? config.videoModels : capability === "image" ? config.imageModels : capability === "text" ? config.textModels : config.audioModels).length };
        const token = slot ? (ctx.tokens.find((item) => item.id === slot.tokenId) ?? { id: slot.tokenId, name: slot.name, group: slot.group, status: 1, expired_time: -1, remain_quota: 0, unlimited_quota: true, auto_groups: [] }) : null;
        const estimate = token ? tokenModelCount(token, capability, ctx) : null;
        return estimate === null ? null : { exact: false, value: estimate };
    };
    const main = count(kind);
    const audio = kind === "text" ? count("audio") : null;
    const candidates = connected && !slot && !usable.length ? createCandidates(kind, ctx) : [];
    const chosenGroup = createGroup !== undefined && candidates.some((item) => item.value === createGroup) ? createGroup : candidates[0]?.value;

    return (
        <div>
            <div className="mb-1 text-sm font-medium">{label}令牌</div>
            <Select
                className="w-full"
                value={slot?.tokenId}
                placeholder={connected ? (usable.length ? `选择${label}令牌` : `没有可用的${label}令牌`) : "登录 openai.fit 后可更换"}
                options={options}
                disabled={!connected || busy}
                loading={busy}
                onChange={(tokenId: number) => void run(() => bridge.chooseToken(kind, tokenId))}
            />
            <div className="mt-1 space-y-0.5 text-xs text-stone-500">
                {slot ? (
                    <div>
                        分组：{groupDesc(slot.group)}
                        {main ? ` · 可用${main.exact ? "" : "约"} ${main.value} 个${label}模型` : ""}
                        {audio ? ` · 语音${audio.exact ? "" : "约"} ${audio.value} 个` : ""}
                    </div>
                ) : null}
                {!connected && slot ? <div>登录 openai.fit 后可更换</div> : null}
                {keyError ? <Typography.Text type="danger" className="block text-xs">这把令牌验证失败：{keyError}</Typography.Text> : null}
                {verified && main?.value === 0 ? <Typography.Text type="danger" className="block text-xs">这把令牌没有可用的{label}模型</Typography.Text> : null}
                {bridge.slotErrors[kind] ? <Typography.Text type="danger" className="block text-xs">{bridge.slotErrors[kind]}</Typography.Text> : null}
            </div>
            {connected && !slot && !usable.length ? (
                candidates.length ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button size="small" type="primary" loading={busy} onClick={() => void run(() => bridge.createToken(kind, chosenGroup ?? ""))}>
                            一键新建{label}令牌
                        </Button>
                        <Select
                            size="small"
                            className="min-w-[180px]"
                            value={chosenGroup}
                            onChange={setCreateGroup}
                            options={candidates.map((item) => ({ value: item.value, label: `${item.group.desc}${item.count === null ? "" : `（${item.count} 个${label}模型）`}` }))}
                        />
                    </div>
                ) : (
                    <div className="mt-1 text-xs text-stone-500">你的账号暂时没有可用的{label}模型分组</div>
                )
            ) : null}
        </div>
    );
}

/** 「更多设置」里的手动填写令牌（高级备用）：填了就视频、图片、文本都用这把。 */
export function FitManualKeyField() {
    const { message } = App.useApp();
    const config = useConfigStore((state) => state.config);
    const fitTokenError = useConfigStore((state) => state.fitTokenError);
    const setFitManualKey = useConfigStore((state) => state.setFitManualKey);
    const refreshFitModels = useConfigStore((state) => state.refreshFitModels);
    const [checking, setChecking] = useState(false);
    const manual = normalizeFitApiKey(config.fitManualKey);

    const verify = async () => {
        setChecking(true);
        try {
            const result = await refreshFitModels();
            if (result) message.success(`已连接 openai.fit：${result.tokenName || "未命名令牌"}`);
            else message.warning("验证期间令牌被更换，这次的验证结果没有使用，请再点一次「验证并同步模型」");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "openai.fit 令牌验证失败");
        } finally {
            setChecking(false);
        }
    };
    const status = !manual
        ? ""
        : fitTokenError ||
          (!config.fitTokenCheckedAt
              ? "令牌尚未验证，点「验证并同步模型」或「完成」时自动验证"
              : `令牌：${config.fitTokenName || "未命名"} · 到期：${config.fitTokenExpiresAt ? new Date(config.fitTokenExpiresAt * 1000).toLocaleString("zh-CN", { hour12: false }) : "永不过期"}`);

    return (
        <div className="space-y-2">
            <div className="text-xs text-stone-500">填了就视频、图片、文本都用这把，优先于上面选的令牌。在 openai.fit 令牌列表点「聊天」带入的也是它。</div>
            <div className="flex flex-wrap items-center gap-2">
                <Input.Password style={{ flex: "1 1 260px" }} value={config.fitManualKey} placeholder="粘贴 openai.fit 令牌，例如 sk-..." autoComplete="off" onChange={(event) => setFitManualKey(event.target.value)} />
                <Button loading={checking} disabled={!manual} onClick={() => void verify()}>
                    验证并同步模型
                </Button>
                <Button
                    danger
                    disabled={!config.fitManualKey}
                    onClick={() => {
                        setFitManualKey("");
                        void useFitBridgeStore.getState().probe();
                    }}
                >
                    清除
                </Button>
            </div>
            {status ? (
                <Typography.Text type={fitTokenError ? "danger" : "secondary"} className="block text-xs">
                    {status}
                </Typography.Text>
            ) : null}
        </div>
    );
}
