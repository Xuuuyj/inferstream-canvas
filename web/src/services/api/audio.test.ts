import assert from "node:assert/strict";
import test from "node:test";
import { FIT_CHANNEL_ID, FIT_ORIGIN } from "@/lib/model-channel";
import { defaultConfig, type AiConfig } from "@/stores/use-config-store";
import type { ReferenceAudio } from "@/types/media";
import { createCanvasAudioTask, requestAudioGeneration } from "./audio";

type Call = { url: string; init?: RequestInit };

/** openai.fit 渠道的配置；各家私有 TTS 的设置都改成非默认值，用来确认它们不会混进标准请求。 */
function fitConfig(model: string, patch: Partial<AiConfig> = {}): AiConfig {
    return {
        ...defaultConfig,
        // 语音跟文本走同一把令牌：视频、图片令牌另有其值，请求里只能出现文本令牌
        fitKeys: {
            video: { tokenId: 1, name: "无限画布-视频", group: "", apiKey: "sk-video-key-0123456789" },
            image: { tokenId: 2, name: "无限画布-图片", group: "", apiKey: "sk-image-key-0123456789" },
            text: { tokenId: 3, name: "无限画布-文本", group: "Claude", apiKey: "sk-text-key-0123456789" },
        },
        model,
        audioModel: model,
        audioModels: [model],
        activeChannelId: FIT_CHANNEL_ID,
        audioChannelId: FIT_CHANNEL_ID,
        localChannels: [{ id: FIT_CHANNEL_ID, protocol: "openai", name: "openai.fit", baseUrl: FIT_ORIGIN, apiKey: "", models: [model], modelCapabilities: { [model]: "audio" } }],
        audioVoice: "nova",
        audioFormat: "wav",
        audioSpeed: "1.25",
        miniMaxTtsVoice: "male-qn-qingse",
        miniMaxTtsFormat: "flac",
        glmTtsVoice: "xiaochen",
        mimoTtsVoice: "茉莉",
        geminiTtsVoice: "Puck",
        ...patch,
    };
}

async function withFetch(respond: () => Response, run: (calls: Call[]) => Promise<void>) {
    const original = globalThis.fetch;
    const calls: Call[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), init });
        return respond();
    }) as typeof fetch;
    try {
        await run(calls);
    } finally {
        globalThis.fetch = original;
    }
}

const audioResponse = () => new Response(new Uint8Array([73, 68, 51, 4]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });

function assertStandardSpeechCall(call: Call, model: string) {
    assert.equal(call.url, "https://openai.fit/v1/audio/speech");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.credentials, "omit");
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("Authorization"), "Bearer sk-text-key-0123456789");
    assert.equal(headers.get("Content-Type"), "application/json");
    assert.deepEqual(JSON.parse(String(call.init?.body)), { model, input: "你好，欢迎来到无限画布。", voice: "nova", response_format: "wav", speed: 1.25 });
}

test("fit 配置下 tts-1 发到 https://openai.fit/v1/audio/speech，请求体是 OpenAI 标准 JSON", async () => {
    await withFetch(audioResponse, async (calls) => {
        const blob = await requestAudioGeneration(fitConfig("tts-1"), "你好，欢迎来到无限画布。");
        assert.equal(calls.length, 1);
        assertStandardSpeechCall(calls[0], "tts-1");
        assert.equal(blob.type, "audio/mpeg");
        assert.equal(blob.size, 4);
    });
});

test("MiniMax、GLM、MiMo、Gemini、Grok 名字的模型在 fit 下照样走 OpenAI 标准路径", async () => {
    for (const model of ["speech-02-hd", "minimax-speech-2.6-hd", "glm-tts", "mimo-v2.5-tts", "mimo-v2.5-tts-voicedesign", "gemini-2.5-flash-preview-tts", "grok-tts"]) {
        await withFetch(audioResponse, async (calls) => {
            await requestAudioGeneration(fitConfig(model, { mimoVoiceDesignPrompt: "" }), "你好，欢迎来到无限画布。");
            assert.equal(calls.length, 1, model);
            assertStandardSpeechCall(calls[0], model);
        });
    }
});

test("声音指令只在填写时才带上", async () => {
    await withFetch(audioResponse, async (calls) => {
        await requestAudioGeneration(fitConfig("gpt-4o-mini-tts", { audioInstructions: "  语气温暖，适合旁白。 " }), "你好");
        assert.equal(JSON.parse(String(calls[0].init?.body)).instructions, "语气温暖，适合旁白。");
    });
});

test("返回的不是 audio/* 类型时按所选格式补上类型", async () => {
    await withFetch(
        () => new Response(new Uint8Array([82, 73, 70, 70]), { status: 200, headers: { "Content-Type": "application/octet-stream" } }),
        async () => {
            const blob = await requestAudioGeneration(fitConfig("tts-1"), "你好");
            assert.equal(blob.type, "audio/wav");
        },
    );
});

test("fit 的报错原样给出，200 但返回 JSON 错误也算失败", async () => {
    await withFetch(
        () => Response.json({ error: { message: "该令牌无权使用模型 tts-1", type: "new_api_error" } }, { status: 403 }),
        async () => {
            await assert.rejects(requestAudioGeneration(fitConfig("tts-1"), "你好"), { message: "该令牌无权使用模型 tts-1" });
        },
    );
    await withFetch(
        () => Response.json({ error: { message: "当前分组上游负载已饱和" } }, { status: 200 }),
        async () => {
            await assert.rejects(requestAudioGeneration(fitConfig("tts-1"), "你好"), { message: "当前分组上游负载已饱和" });
        },
    );
    await withFetch(
        () => new Response("bad gateway", { status: 502 }),
        async () => {
            await assert.rejects(requestAudioGeneration(fitConfig("tts-1"), "你好"), { message: "音频生成失败（502）" });
        },
    );
});

test("连不上 openai.fit 时给出网络提示，用户主动停止时原样抛出", async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = (async () => {
            throw new TypeError("Failed to fetch");
        }) as unknown as typeof fetch;
        await assert.rejects(requestAudioGeneration(fitConfig("tts-1"), "你好"), { message: "连接原模型服务失败，请检查网络后重试" });
        const controller = new AbortController();
        controller.abort();
        globalThis.fetch = (async () => {
            throw new DOMException("The operation was aborted.", "AbortError");
        }) as unknown as typeof fetch;
        await assert.rejects(requestAudioGeneration(fitConfig("tts-1"), "你好", undefined, controller.signal), { name: "AbortError" });
    } finally {
        globalThis.fetch = original;
    }
});

test("没有令牌、没有语音模型、带参考音频时不发请求", async () => {
    const reference: ReferenceAudio = { id: "a1", url: "https://example.com/a.mp3", type: "audio/mpeg", name: "a.mp3" };
    await withFetch(audioResponse, async (calls) => {
        await assert.rejects(requestAudioGeneration(fitConfig("tts-1", { fitKeys: {}, fitManualKey: "  " }), "你好"), { message: "缺少可用的文本令牌，请在设置中查看模型服务状态" });
        await assert.rejects(requestAudioGeneration(fitConfig("", { audioModels: [] }), "你好"), { message: "原模型服务暂无语音模型" });
        await assert.rejects(requestAudioGeneration(fitConfig("tts-1"), "你好", reference), { message: "原模型服务语音不支持参考音频" });
        // 画布节点走 createCanvasAudioTask：fit 下直接进 fit 分支，不经过渠道参数翻译和旧的配置检查。
        await assert.rejects(createCanvasAudioTask(fitConfig("tts-1", { fitKeys: { video: { tokenId: 1, name: "无限画布-视频", group: "", apiKey: "sk-video-key-0123456789" } } }), "你好", { clientTaskId: "t1" }), { message: "缺少可用的文本令牌，请在设置中查看模型服务状态" });
        await assert.rejects(createCanvasAudioTask(fitConfig("speech-02-hd"), "你好", { clientTaskId: "t2" }, reference), { message: "原模型服务语音不支持参考音频" });
        assert.equal(calls.length, 0);
    });
});
