import assert from "node:assert/strict";
import test from "node:test";

import { inferStreamImageModel, saveInferStreamImageToken, verifyInferStreamImageToken } from "@/lib/inferstream-image-access";
import type { AdminPublicSettings } from "@/services/api/admin";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { useUserStore } from "@/stores/use-user-store";
import type { AuthUser } from "@/services/api/auth";

test("InferStream text and reference image generation use only the gateway token and return an image", async () => {
    const previousFetch = globalThis.fetch;
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
    const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
    const previousConfig = useConfigStore.getState();
    const previousUser = useUserStore.getState();
    const values = new Map<string, string>();
    Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key),
    } });
    const savedValues = new Map<string, string>();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
        getItem: (key: string) => savedValues.get(key) ?? null,
        setItem: (key: string, value: string) => savedValues.set(key, value),
        removeItem: (key: string) => savedValues.delete(key),
    } });
    const userId = "inferstream-test-user";
    useConfigStore.setState({ publicSettings: { auth: { inferStreamLogin: true } } as AdminPublicSettings });
    useUserStore.setState({ user: { id: userId } as AuthUser, token: "" });
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (target, init) => {
        const url = String(target);
        calls.push({ url, init: init ?? {} });
        return Response.json(url.endsWith("/models")
            ? { data: [{ id: inferStreamImageModel }] }
            : { data: [{ b64_json: "YWJj" }] });
    }) as typeof fetch;
    try {
        const config = { ...defaultConfig, model: inferStreamImageModel, count: "1", fitManualKey: "legacy-test-value" };
        await assert.rejects(requestGeneration(config, "Create a forklift"), /InferStream API Token/);
        assert.equal(calls.length, 0);
        assert.equal(useConfigStore.getState().isAiConfigReady(config, config.model), false);
        await verifyInferStreamImageToken("gateway-test-key");
        values.set(`inferstream-image-api-token:${userId}`, "gateway-test-key");
        assert.equal(useConfigStore.getState().isAiConfigReady(config, config.model), true);
        assert.equal(values.size, 0);
        assert.equal(savedValues.get(`inferstream-image-api-token:${userId}`), "gateway-test-key");
        assert.equal(useConfigStore.getState().isAiConfigReady({ ...config, fitManualKey: "" }, config.model), true);
        assert.match((await requestGeneration(config, "Create a forklift"))[0].dataUrl, /YWJj$/);
        const images = await requestEdit(config, "Put the forklift in a warehouse", [
            { id: "ref", name: "ref.png", type: "image/png", dataUrl: "data:image/png;base64,YWJj" },
        ]);
        assert.match(images[0].dataUrl, /YWJj$/);
        assert.deepEqual(calls.map(({ url }) => url), [
            "/inferstream/v1/models", "/inferstream/v1/images/generations", "/inferstream/v1/images/edits",
        ]);
        for (const { init } of calls) {
            assert.equal(new Headers(init.headers).get("Authorization"), "Bearer gateway-test-key");
            assert.equal(init.credentials, "omit");
            assert.equal(init.redirect, "error");
        }
        const editRequest = calls[2].init.body as FormData;
        assert.equal(editRequest.get("model"), inferStreamImageModel);
        assert.ok(editRequest.get("image") instanceof File);
        saveInferStreamImageToken(userId, "");
        assert.equal(useConfigStore.getState().isAiConfigReady(config, config.model), false);
    } finally {
        globalThis.fetch = previousFetch;
        if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
        else Reflect.deleteProperty(globalThis, "window");
        useConfigStore.setState(previousConfig);
        useUserStore.setState(previousUser);
        if (previousLocalStorage) Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
        else Reflect.deleteProperty(globalThis, "localStorage");
        if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
        else Reflect.deleteProperty(globalThis, "sessionStorage");
    }
});
