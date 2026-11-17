import assert from "node:assert/strict";
import test from "node:test";
import { useUserStore } from "@/stores/use-user-store";
import { MEDIA_PROXY_LOGIN_REQUIRED, ensureImagePreview, uploadImage } from "./image-storage";

const BACKUP = `https://openai.fit/v1/tasks/img-req_1/artifacts/0/content?access=${"B".repeat(43)}`;
const OSS = "https://fadacai-openai-fit.oss-cn-shenzhen.aliyuncs.com/artifacts/img-req_1-0.png?Expires=1&Signature=x";
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const proxyPath = (url: string) => `/api/proxy-image?url=${encodeURIComponent(url)}`;
const png = () => new Response(new Blob([PNG_BYTES], { type: "image/png" }), { headers: { "content-type": "image/png" } });
const corsBlocked = () => Promise.reject(new TypeError("Failed to fetch"));

type Call = { url: string; authorization: string };

/** 接管全局 fetch，按地址找桩；token 是画布账号的登录令牌。 */
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

// bun 里没有 IndexedDB，uploadImage 取到图片后存进浏览器这一步会失败；这里只看取图走了哪些地址、取到的是不是图片。
const storedAfterFetch = (error: unknown) => error instanceof Error && !/Failed to fetch|代理图片拉取失败|登录后/.test(error.message);

test("uploadImage：openai.fit 的图片直连被拦（或 OSS 回 403）时，登录用户经 /api/proxy-image 再取一次（带画布登录令牌）", async () => {
    await withFetch("canvas-token", { [BACKUP]: corsBlocked, [proxyPath(BACKUP)]: png }, async (calls) => {
        await assert.rejects(uploadImage(BACKUP, { localOnly: true }), storedAfterFetch);
        assert.deepEqual(calls, [
            { url: BACKUP, authorization: "" },
            { url: proxyPath(BACKUP), authorization: "Bearer canvas-token" },
        ]);
    });
    await withFetch("canvas-token", { [OSS]: () => new Response("denied", { status: 403 }), [proxyPath(OSS)]: png }, async (calls) => {
        await assert.rejects(uploadImage(OSS, { localOnly: true }), storedAfterFetch);
        assert.deepEqual(
            calls.map((call) => call.url),
            [OSS, proxyPath(OSS)],
        );
    });
});

test("uploadImage：没登录时直连失败不把签名链接交给画布服务器；其他远程地址照旧直接走代理", async () => {
    await withFetch("", { [BACKUP]: corsBlocked }, async (calls) => {
        await assert.rejects(uploadImage(BACKUP, { localOnly: true }), { message: MEDIA_PROXY_LOGIN_REQUIRED });
        assert.deepEqual(
            calls.map((call) => call.url),
            [BACKUP],
        );
    });
    await withFetch("", { [OSS]: () => new Response("denied", { status: 403 }) }, async (calls) => {
        await assert.rejects(uploadImage(OSS, { localOnly: true }), { message: "代理图片拉取失败：403" });
        assert.equal(calls.length, 1);
    });
    const other = "https://cdn.example.com/cat.png";
    await withFetch("canvas-token", { [proxyPath(other)]: png }, async (calls) => {
        await assert.rejects(uploadImage(other, { localOnly: true }), storedAfterFetch);
        assert.deepEqual(calls, [{ url: proxyPath(other), authorization: "" }]);
    });
});

test("ensureImagePreview：缩略图取 openai.fit 的图同样直连失败再走代理，没登录只直连", async () => {
    // bun 里做不了缩略图（没有 createImageBitmap），预览返回 undefined；这里只看取图的地址
    await withFetch("canvas-token", { [BACKUP]: corsBlocked, [proxyPath(BACKUP)]: png }, async (calls) => {
        assert.equal(await ensureImagePreview("test:fit-login", BACKUP), undefined);
        assert.deepEqual(calls, [
            { url: BACKUP, authorization: "" },
            { url: proxyPath(BACKUP), authorization: "Bearer canvas-token" },
        ]);
    });
    await withFetch("", { [BACKUP]: corsBlocked }, async (calls) => {
        assert.equal(await ensureImagePreview("test:fit-guest", BACKUP), undefined);
        assert.deepEqual(
            calls.map((call) => call.url),
            [BACKUP],
        );
    });
});
