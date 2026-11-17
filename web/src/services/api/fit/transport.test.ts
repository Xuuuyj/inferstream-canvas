import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fitAuthHeaders } from "./transport";

const SRC = fileURLToPath(new URL("../../../", import.meta.url));
const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });

test("浏览器直连 openai.fit 只走 /v1/*、/v1beta/* 和 fit 开了跨域的 /api/usage/token/；/api/pricing 这类不带跨域头，价目表和能力目录走画布服务器的 /api/fit/catalog", () => {
    // 发往 openai.fit 的请求都在这两处：fitFetch / fitGet 的调用方，和 fit 生成库同步副本（fetch 换成了 fitFetch，路径来自 request-builders、upload-client）
    const paths = new Set<string>();
    for (const file of [...sources(join(SRC, "services/api/fit")), ...sources(join(SRC, "lib/fit-generate"))]) {
        for (const match of readFileSync(file, "utf8").matchAll(/["'`](\/(?:api|v1)[^"'`$]*)/g)) paths.add(match[1]);
    }
    assert.deepEqual([...paths].filter((path) => !/^\/v1(beta)?\//.test(path)).sort(), ["/api/fit/catalog", "/api/usage/token/"]);
    // /api/fit/catalog 是同源的画布服务器（apiGet），不是 openai.fit
    assert.match(readFileSync(join(SRC, "services/api/fit/catalog.ts"), "utf8"), /apiGet<FitCatalog>\("\/api\/fit\/catalog"\)/);
    assert.match(readFileSync(join(SRC, "services/api/fit/token.ts"), "utf8"), /fitGet\("\/api\/usage\/token\/", apiKey,/);
    // 别处也没有拼 openai.fit 的 /api/ 地址
    for (const file of sources(SRC)) assert.doesNotMatch(readFileSync(file, "utf8"), /openai\.fit\/api|FIT_ORIGIN\}\/api|getFitOrigin\(\)\s*\+\s*["'`]\/api/, file);
});

test("the openai.fit token is attached only to requests whose origin is exactly https://openai.fit", () => {
    for (const target of ["https://openai.fit/v1/images/generations", "https://openai.fit/v1/videos/abc?model=x", "https://OpenAI.fit/v1/models"]) {
        assert.deepEqual(fitAuthHeaders(target, "sk-abc"), { Authorization: "Bearer sk-abc" }, target);
    }
});

test("requests to the canvas server and to any other host never carry the token", () => {
    for (const target of [
        "/api/v1/canvas/image-tasks",
        "/api/v1/video-tasks",
        "api/v1/chat/completions",
        "//openai.fit/v1/models",
        "http://openai.fit/v1/models",
        "https://openai.fit:8443/v1/models",
        "https://openai.fit.evil.com/v1/models",
        "https://evil.com/v1/models?next=https://openai.fit",
        "https://user:pass@evil.com/openai.fit",
        "https://img.openai.fit/a.png",
        "",
        "not a url",
    ]) {
        assert.deepEqual(fitAuthHeaders(target, "sk-abc"), {}, target);
    }
});

test("an empty token adds no Authorization header", () => {
    assert.deepEqual(fitAuthHeaders("https://openai.fit/v1/models", ""), {});
    assert.deepEqual(fitAuthHeaders("https://openai.fit/v1/models", "  "), {});
});
