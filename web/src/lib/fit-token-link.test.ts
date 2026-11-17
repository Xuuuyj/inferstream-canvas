import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fitTokenLinkWarning, maskFitApiKey, parseFitTokenLink } from "./fit-token-link";

test("reads the token from the hash written by fit's chat link", () => {
    const link = parseFitTokenLink("https://canvas.openai.fit/#apiKey=sk-abc123&baseUrl=https://openai.fit");
    assert.deepEqual(link, { apiKey: "sk-abc123", foreignBaseUrl: "", keyInQuery: false, cleanUrl: "/" });
    assert.equal(parseFitTokenLink("https://canvas.openai.fit/#apikey=sk-h1")?.apiKey, "sk-h1");
});

test("a token in the query string is never imported and is stripped from the address", () => {
    assert.deepEqual(parseFitTokenLink("https://canvas.openai.fit/canvas?apikey=sk-q1"), { apiKey: "", foreignBaseUrl: "", keyInQuery: true, cleanUrl: "/canvas" });
    assert.deepEqual(parseFitTokenLink("https://canvas.openai.fit/?apiKey=sk-q2&baseurl=https%3A%2F%2Fopenai.fit"), { apiKey: "", foreignBaseUrl: "", keyInQuery: true, cleanUrl: "/" });
    assert.deepEqual(parseFitTokenLink("https://canvas.openai.fit/?apiKey="), { apiKey: "", foreignBaseUrl: "", keyInQuery: true, cleanUrl: "/" });
});

test("a query-string token wins over a hash token: nothing is imported and both are stripped", () => {
    const link = parseFitTokenLink("https://canvas.openai.fit/canvas/abc?x=1&apiKey=sk-q&y=2#apiKey=sk-h&baseUrl=https://openai.fit&tab=3");
    assert.deepEqual(link, { apiKey: "", foreignBaseUrl: "", keyInQuery: true, cleanUrl: "/canvas/abc?x=1&y=2#tab=3" });
    assert.equal(parseFitTokenLink("https://canvas.openai.fit/canvas?apiKey=sk-q#section")?.cleanUrl, "/canvas#section");
});

test("adds the sk- prefix when the link carries a bare key", () => {
    assert.equal(parseFitTokenLink("https://canvas.openai.fit/#apiKey=abc123")?.apiKey, "sk-abc123");
    assert.equal(parseFitTokenLink("https://canvas.openai.fit/#apiKey=%20abc%20")?.apiKey, "sk-abc");
});

test("ignores a token whose baseUrl is not openai.fit and flags it", () => {
    const link = parseFitTokenLink("https://canvas.openai.fit/#apiKey=sk-evil&baseUrl=https://evil.com");
    assert.deepEqual(link, { apiKey: "", foreignBaseUrl: "https://evil.com", keyInQuery: false, cleanUrl: "/" });
    for (const baseUrl of ["http://openai.fit", "https://openai.fit.evil.com", "https://evil.com/openai.fit", "https://openai.fit:8443", "https://openai.fit/api", "not a url"]) {
        assert.equal(parseFitTokenLink(`https://canvas.openai.fit/#apiKey=sk-x&baseUrl=${encodeURIComponent(baseUrl)}`)?.apiKey, "", baseUrl);
    }
});

test("only the hash baseUrl counts; a query baseUrl is stripped but ignored", () => {
    const link = parseFitTokenLink("https://canvas.openai.fit/?baseUrl=https%3A%2F%2Fevil.com#apiKey=sk-ok");
    assert.deepEqual(link, { apiKey: "sk-ok", foreignBaseUrl: "", keyInQuery: false, cleanUrl: "/" });
});

test("accepts openai.fit with or without a trailing slash or /v1", () => {
    for (const baseUrl of ["https://openai.fit", "https://openai.fit/", "https://openai.fit/v1", "https://openai.fit/v1/"]) {
        const link = parseFitTokenLink(`https://canvas.openai.fit/#apiKey=sk-ok&baseUrl=${baseUrl}`);
        assert.deepEqual([link?.apiKey, link?.foreignBaseUrl], ["sk-ok", ""], baseUrl);
    }
});

test("the cleaned URL drops the token and keeps every other parameter", () => {
    const link = parseFitTokenLink("https://canvas.openai.fit/canvas/abc?x=1&y=2#apiKey=sk-h&baseUrl=https://openai.fit&tab=3");
    assert.equal(link?.apiKey, "sk-h");
    assert.equal(link?.cleanUrl, "/canvas/abc?x=1&y=2#tab=3");
});

test("returns null when the link carries no token parameters", () => {
    assert.equal(parseFitTokenLink("https://canvas.openai.fit/canvas?x=1#tab=2"), null);
});

test("masks a token down to its last four characters", () => {
    assert.equal(maskFitApiKey("sk-1234567890abcd"), "sk-…abcd");
});

test("接线（bun 导入 tsx 太慢，按源码查）：#apiKey= 链接确认后存成手动令牌（视频、图片、文本都用它），和当前手动令牌比较", () => {
    const root = readFileSync(new URL("../components/layout/client-root-init.tsx", import.meta.url), "utf8");
    assert.match(root, /const connect = \(\) => \{\s+setFitManualKey\(apiKey\);/);
    assert.match(root, /const currentKey = normalizeFitApiKey\(useConfigStore\.getState\(\)\.config\.fitManualKey\);/);
    assert.match(root, /确认后视频、图片、文本都用这把令牌（手动令牌）/);
    assert.doesNotMatch(root, /setFitApiKey|config\.apiKey/);
});

test("the #apiKey= confirm warns that the token's owner sees what is made with it, more pointedly while the browser is signed in to openai.fit", () => {
    assert.match(fitTokenLinkWarning(false), /令牌主人都能看到/);
    assert.doesNotMatch(fitTokenLinkWarning(false), /不是从你登录的/);
    assert.match(fitTokenLinkWarning(true), /不是从你登录的 openai\.fit 账号里选的/);
    assert.match(fitTokenLinkWarning(true), /令牌主人都能看到/);
    const root = readFileSync(new URL("../components/layout/client-root-init.tsx", import.meta.url), "utf8");
    assert.match(root, /fitTokenLinkWarning\(useFitBridgeStore\.getState\(\)\.fitLoggedIn === true\)/);
});
