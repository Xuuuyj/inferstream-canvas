import assert from "node:assert/strict";
import test from "node:test";
import { MEDIA_PROXY_LOGIN_REQUIRED } from "@/services/image-storage";
import { useUserStore } from "@/stores/use-user-store";
import { captureVideoFrame } from "./canvas-video-frame";

const SIGNED = `https://openai.fit/v1/tasks/task_s/artifacts/video/content?access=${"A".repeat(43)}`;
const proxyPath = (url: string) => `/api/proxy-image?url=${encodeURIComponent(url)}`;

/** 假的 <video>：blob: 地址能读出画面，其他地址（跨域被拦的远程链接）触发 error。 */
class FakeVideo {
    crossOrigin = "";
    muted = false;
    playsInline = false;
    preload = "";
    readyState = 0;
    duration = 4;
    videoWidth = 64;
    videoHeight = 36;
    currentTime = 0;
    private source = "";
    private listeners = new Map<string, Set<() => void>>();

    constructor(private loaded: string[]) {}

    set src(value: string) {
        this.source = value;
    }

    addEventListener(name: string, listener: () => void) {
        this.listeners.set(name, (this.listeners.get(name) ?? new Set()).add(listener));
    }

    removeEventListener(name: string, listener: () => void) {
        this.listeners.get(name)?.delete(listener);
    }

    removeAttribute() {
        this.source = "";
    }

    load() {
        const source = this.source;
        if (!source) return;
        this.loaded.push(source);
        setTimeout(() => {
            if (source.startsWith("blob:")) this.readyState = 2;
            this.listeners.get(source.startsWith("blob:") ? "loadedmetadata" : "error")?.forEach((listener) => listener());
        });
    }
}

async function withDom(token: string, routes: Record<string, () => Response | Promise<Response>>, run: (ctx: { loaded: string[]; fetched: string[] }) => Promise<void>) {
    const globals = globalThis as Record<string, unknown>;
    const original = { document: globals.document, media: globals.HTMLMediaElement, fetch: globalThis.fetch };
    const loaded: string[] = [];
    const fetched: string[] = [];
    globals.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };
    globals.document = {
        createElement: (tag: string) => (tag === "video" ? new FakeVideo(loaded) : { width: 0, height: 0, getContext: () => ({ drawImage: () => undefined }), toBlob: (done: (blob: Blob) => void) => done(new Blob(["frame"], { type: "image/png" })) }),
    };
    globalThis.fetch = (async (input: RequestInfo | URL) => {
        fetched.push(String(input));
        const route = routes[String(input)];
        if (!route) throw new Error(`unexpected request ${String(input)}`);
        return route();
    }) as typeof fetch;
    useUserStore.setState({ token });
    try {
        await run({ loaded, fetched });
    } finally {
        globals.document = original.document;
        globals.HTMLMediaElement = original.media;
        globalThis.fetch = original.fetch;
        useUserStore.setState({ token: "" });
    }
}

test("fit 签名链接截帧被跨域拦下时，登录用户经代理下载到本地再截", async () => {
    const routes = { [SIGNED]: () => Promise.reject(new TypeError("Failed to fetch")), [proxyPath(SIGNED)]: () => new Response(new Blob([new Uint8Array([0, 0, 0, 32])], { type: "video/mp4" })) };
    await withDom("canvas-token", routes, async ({ loaded, fetched }) => {
        const frame = await captureVideoFrame(SIGNED, "first", 0);
        assert.equal(frame.type, "image/png");
        assert.equal(loaded[0], SIGNED);
        assert.match(loaded[1], /^blob:/);
        assert.deepEqual(fetched, [SIGNED, proxyPath(SIGNED)]);
    });
});

test("没登录时提示登录、不发代理请求；本机地址截不出照旧原样报错", async () => {
    await withDom("", {}, async ({ fetched }) => {
        await assert.rejects(captureVideoFrame(SIGNED, "first", 0), { message: MEDIA_PROXY_LOGIN_REQUIRED });
        assert.deepEqual(fetched, []);
    });
    await withDom("canvas-token", {}, async ({ fetched }) => {
        await assert.rejects(captureVideoFrame("https://localhost:3000/clip.mp4", "first", 0), { message: "Failed to read video frame" });
        assert.deepEqual(fetched, []);
    });
});
