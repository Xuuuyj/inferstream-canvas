import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, saveRetryDelayMs } from "./request";

const now = Date.parse("2026-11-01T00:00:00Z");

test("a 429 waits for Retry-After, given in seconds or as an HTTP date", () => {
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429, "7"), 5000, now), 7000);
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429, " 12 "), 5000, now), 12000);
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429, "Sun, 01 Nov 2026 00:00:30 GMT"), 5000, now), 30000);
});

test("a 429 without a usable Retry-After falls back to the backoff, and never retries sooner than 1 second", () => {
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429), 5000, now), 5000);
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429, "soon"), 8000, now), 8000);
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429, "0"), 5000, now), 1000);
    assert.equal(saveRetryDelayMs(new ApiError("请求过于频繁", 429, "Sat, 31 Oct 2026 23:00:00 GMT"), 5000, now), 1000);
});

test("network failures and 5xx retry after the backoff", () => {
    assert.equal(saveRetryDelayMs(new ApiError("接口连接失败", 0), 5000, now), 5000);
    assert.equal(saveRetryDelayMs(new ApiError("接口返回异常", 502, "60"), 20000, now), 20000);
});

test("other client errors and non-API errors are not retried", () => {
    for (const error of [new ApiError("请求体过大", 413), new ApiError("未登录或权限不足", 401), new ApiError("请求失败", 200), new Error("boom"), "boom"]) {
        assert.equal(saveRetryDelayMs(error, 5000, now), null);
    }
});
