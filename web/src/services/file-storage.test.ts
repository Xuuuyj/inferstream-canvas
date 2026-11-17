import assert from "node:assert/strict";
import test from "node:test";
import { useUserStore } from "@/stores/use-user-store";
import { downloadRemoteMedia } from "./file-storage";
import { MEDIA_PROXY_LOGIN_REQUIRED } from "./image-storage";

const SIGNED = `https://openai.fit/v1/tasks/task_s/artifacts/video/content?access=${"A".repeat(43)}`;
const OSS = "https://fadacai-openai-fit.oss-cn-shenzhen.aliyuncs.com/artifacts/task_s.mp4?Expires=1&Signature=x";
const VIDEO_BYTES = new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112]);
const proxyPath = (url: string) => `/api/proxy-image?url=${encodeURIComponent(url)}`;
const video = () => new Response(new Blob([VIDEO_BYTES], { type: "video/mp4" }));

type Call = { url: string; authorization: string };

/** 接管全局 fetch，按地址找桩（桩可以抛 TypeError 模拟跨域被拦或断网）；token 是画布账号的登录令牌。 */
async function withFetch(token: string, routes: Record<string, () => Response | Promise<Response>>, run: (calls: Call[]) => Promise<void>) {
    const original = globalThis.fetch;
    const calls: Call[] = [];
    useUserStore.setState({ token });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get("Authorization") || "" });
        const route = routes[String(input)];
        if (!route) throw new Error(`unexpected request ${String(input)}`);
        return route();
    }) as typeof fetch;
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
        useUserStore.setState({ token: "" });
    }
}

const corsBlocked = () => Promise.reject(new TypeError("Failed to fetch"));

test("fit 成片先直连；签名链接被 OSS 跨域拦下时，登录用户经 /api/proxy-image 再取一次（带画布登录令牌，不带 openai.fit 令牌）", async () => {
    await withFetch("canvas-token", { [SIGNED]: corsBlocked, [proxyPath(SIGNED)]: video }, async (calls) => {
        const blob = await downloadRemoteMedia(SIGNED);
        assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), VIDEO_BYTES);
        assert.deepEqual(calls, [
            { url: SIGNED, authorization: "" },
            { url: proxyPath(SIGNED), authorization: "Bearer canvas-token" },
        ]);
    });
});

test("直连回非 2xx（OSS 403）时同样经代理重试一次；直连成功就不走代理", async () => {
    await withFetch("canvas-token", { [OSS]: () => new Response("denied", { status: 403 }), [proxyPath(OSS)]: video }, async (calls) => {
        assert.equal((await downloadRemoteMedia(OSS)).size, VIDEO_BYTES.length);
        assert.deepEqual(
            calls.map((call) => call.url),
            [OSS, proxyPath(OSS)],
        );
    });
    await withFetch("canvas-token", { [SIGNED]: video }, async (calls) => {
        assert.equal((await downloadRemoteMedia(SIGNED)).size, VIDEO_BYTES.length);
        assert.deepEqual(
            calls.map((call) => call.url),
            [SIGNED],
        );
    });
});

test("没登录时直连失败不把签名链接交给画布服务器，提示登录；代理回 401（登录过期）也提示登录", async () => {
    await withFetch("", { [SIGNED]: corsBlocked }, async (calls) => {
        await assert.rejects(downloadRemoteMedia(SIGNED), { message: MEDIA_PROXY_LOGIN_REQUIRED });
        assert.deepEqual(
            calls.map((call) => call.url),
            [SIGNED],
        );
    });
    await withFetch("expired-token", { [SIGNED]: corsBlocked, [proxyPath(SIGNED)]: () => Response.json({ code: 401, msg: "登录后才能代理视频和音频" }, { status: 401 }) }, async () => {
        await assert.rejects(downloadRemoteMedia(SIGNED), { message: MEDIA_PROXY_LOGIN_REQUIRED });
    });
    await withFetch("", { [OSS]: () => new Response("gone", { status: 404 }) }, async (calls) => {
        await assert.rejects(downloadRemoteMedia(OSS), { message: "媒体下载失败：404" });
        assert.equal(calls.length, 1);
    });
});

test("其他远程地址照旧直接走代理", async () => {
    const other = "https://cdn.example.com/clip.mp4";
    await withFetch("canvas-token", { [proxyPath(other)]: video }, async (calls) => {
        assert.equal((await downloadRemoteMedia(other)).size, VIDEO_BYTES.length);
        assert.deepEqual(calls, [{ url: proxyPath(other), authorization: "Bearer canvas-token" }]);
    });
});
