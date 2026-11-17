import assert from "node:assert/strict";
import test from "node:test";

import { autoImportInferStreamKeys, inferStreamToken, inferStreamTokenLabel, saveInferStreamToken } from "@/lib/inferstream-image-access";
import type { AdminPublicSettings } from "@/services/api/admin";
import type { AuthUser } from "@/services/api/auth";
import { createInferStreamVideoTask, inferStreamVideoBody, inferStreamVideoIssue, waitInferStreamVideo } from "@/services/api/inferstream-video";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";

type Call = { url: string; init: RequestInit };

function setup(userId: string) {
    const previous = {
        fetch: globalThis.fetch,
        window: Object.getOwnPropertyDescriptor(globalThis, "window"),
        local: Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
        session: Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"),
        config: useConfigStore.getState(),
        user: useUserStore.getState(),
    };
    const storage = () => {
        const values = new Map<string, string>();
        return { values, api: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } };
    };
    const local = storage();
    const session = storage();
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: local.api });
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: session.api });
    useConfigStore.setState({ publicSettings: { auth: { inferStreamLogin: true } } as AdminPublicSettings });
    useUserStore.setState({ user: { id: userId } as AuthUser, token: "" });
    const calls: Call[] = [];
    const restore = () => {
        globalThis.fetch = previous.fetch;
        for (const [name, descriptor] of [["window", previous.window], ["localStorage", previous.local], ["sessionStorage", previous.session]] as const) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        useConfigStore.setState(previous.config, true);
        useUserStore.setState(previous.user, true);
    };
    return { calls, local, session, restore };
}

const config = (overrides: Partial<typeof defaultConfig> = {}) => ({ ...defaultConfig, model: "seedance-2.0-mini", videoModel: "seedance-2.0-mini", videoSeconds: "", vquality: "720", size: "1280x720", systemPrompt: "", systemPrompts: { ...defaultConfig.systemPrompts, video: "" }, ...overrides });

test("InferStream video body follows the model's range and refuses what it cannot do", () => {
    assert.deepEqual(inferStreamVideoBody(config(), "a cat surfing"), { model: "seedance-2.0-mini", prompt: "a cat surfing", seconds: "5", duration: 5, resolution: "720p", ratio: "16:9" });
    assert.equal(inferStreamVideoBody(config({ size: "720x1280", vquality: "480", videoSeconds: "15" }), "x").ratio, "9:16");
    assert.equal(inferStreamVideoBody(config({ size: "auto" }), "x").ratio, "adaptive");
    assert.throws(() => inferStreamVideoBody(config({ videoSeconds: "3" }), "x"), /4–15 秒/);
    assert.throws(() => inferStreamVideoBody(config({ vquality: "1080" }), "x"), /480p、720p/);
    assert.throws(() => inferStreamVideoBody(config({ model: "grok-imagine-video", videoModel: "grok-imagine-video" }), "x"), /暂不支持视频模型/);
    assert.match(inferStreamVideoIssue(config(), "x", { references: [{ id: "r", dataUrl: "data:image/png;base64,AA", mimeType: "image/png", name: "r.png" } as never] }), /只支持文生视频/);
    assert.equal(inferStreamVideoIssue(config(), "x", {}), "");
});

test("InferStream video submits, polls and downloads with the video key, not the image key", async () => {
    const env = setup("video-user");
    try {
        saveInferStreamToken("image", "video-user", "sk-image");
        saveInferStreamToken("video", "video-user", "sk-video", "我的视频 Key");
        let polls = 0;
        globalThis.fetch = (async (target, init) => {
            const url = String(target);
            env.calls.push({ url, init: init ?? {} });
            if (url === "/inferstream/v1/videos") return Response.json({ id: "video_abc", object: "video", status: "queued", progress: 0 });
            if (url === "/inferstream/v1/videos/video_abc") {
                polls += 1;
                return Response.json(polls < 2 ? { id: "video_abc", status: "in_progress", progress: 40 } : { id: "video_abc", status: "completed", progress: 100 });
            }
            if (url === "/inferstream/v1/videos/video_abc/content") return new Response(new Blob(["MP4"], { type: "video/mp4" }));
            return new Response("not found", { status: 404 });
        }) as typeof fetch;

        assert.equal(inferStreamTokenLabel("video", "video-user"), "我的视频 Key");
        const created = await createInferStreamVideoTask(config(), "a cat surfing", {});
        assert.equal(created.task.id, "video_abc");
        const submit = env.calls[0];
        assert.equal((submit.init.headers as Record<string, string>).Authorization, "Bearer sk-video");
        assert.equal(submit.init.credentials, "omit");
        assert.deepEqual(JSON.parse(String(submit.init.body)), { model: "seedance-2.0-mini", prompt: "a cat surfing", seconds: "5", duration: 5, resolution: "720p", ratio: "16:9" });

        const progress: number[] = [];
        const saved: Blob[] = [];
        const result = await waitInferStreamVideo(created.task, {
            intervalMs: 1,
            onProgress: (value) => progress.push(value),
            save: async (blob, id) => {
                saved.push(blob);
                return { url: `blob:${id}`, storageKey: `k:${id}` };
            },
        });
        assert.equal(result.url, "blob:video_abc");
        assert.equal(result.task.status, "completed");
        assert.deepEqual(progress, [40, 100]);
        assert.equal(await saved[0].text(), "MP4");
        assert.ok(env.calls.every(({ init }) => (init.headers as Record<string, string>).Authorization === "Bearer sk-video"));
    } finally {
        env.restore();
    }
});

test("A failed InferStream video surfaces the gateway's reason", async () => {
    const env = setup("fail-user");
    try {
        saveInferStreamToken("video", "fail-user", "sk-video");
        globalThis.fetch = (async () => Response.json({ id: "video_x", status: "failed", error: { message: "内容不合规" } })) as unknown as typeof fetch;
        await assert.rejects(waitInferStreamVideo({ id: "video_x", task_id: "video_x" }, { intervalMs: 1 }), /内容不合规/);
    } finally {
        env.restore();
    }
});

test("Auto-import picks a usable account key for each missing capability", async () => {
    const env = setup("import-user");
    try {
        const keys = [
            { id: 3, name: "只能生图", key_hint: "sk-…3333", org_id: 0, unlimited_quota: true, remain_quota: 0, models: ["gpt-image-2"] },
            { id: 2, name: "通用", key_hint: "sk-…2222", org_id: 0, unlimited_quota: true, remain_quota: 0, models: [] },
        ];
        const full: Record<number, string> = { 3: "sk-img3333", 2: "sk-all2222" };
        globalThis.fetch = (async (target, init) => {
            const url = String(target);
            env.calls.push({ url, init: init ?? {} });
            if (url === "https://www.inferstream.cn/api/canvas/keys") return Response.json({ success: true, data: keys });
            const reveal = /\/api\/canvas\/keys\/(\d+)$/.exec(url);
            if (reveal) return Response.json({ success: true, data: { key: full[Number(reveal[1])], name: "" } });
            if (url === "/inferstream/v1/models") {
                const auth = (init?.headers as Record<string, string>).Authorization;
                return Response.json({ data: auth === "Bearer sk-img3333" ? [{ id: "gpt-image-2" }] : [{ id: "gpt-image-2" }, { id: "seedance-2.0-mini" }] });
            }
            return new Response("not found", { status: 404 });
        }) as typeof fetch;

        await autoImportInferStreamKeys("import-user");
        assert.equal(inferStreamToken("image", "import-user"), "sk-img3333");
        assert.equal(inferStreamToken("video", "import-user"), "sk-all2222");
        assert.equal(inferStreamTokenLabel("video", "import-user"), "通用");
        const accountCalls = env.calls.filter(({ url }) => url.startsWith("https://www.inferstream.cn/"));
        assert.ok(accountCalls.every(({ init }) => init.credentials === "include" && (init.headers as Record<string, string>)["X-InferStream-Canvas"] === "1"));

        // Keys already chosen are left alone, and the account is not asked again.
        env.calls.length = 0;
        await autoImportInferStreamKeys("import-user");
        assert.equal(env.calls.length, 0);
    } finally {
        env.restore();
    }
});
