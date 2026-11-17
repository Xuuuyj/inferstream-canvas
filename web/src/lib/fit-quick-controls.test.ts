import assert from "node:assert/strict";
import test from "node:test";
import { buildModelProfile } from "@/lib/fit-generate/lib/model-profiles";
import type { PricingModel } from "@/lib/fit-generate/shims/pricing-types";
import { canvasToFitValues, type FitValuesConfig } from "@/services/api/fit/values";
import { fitPanel } from "./fit-panel";
import { fitQuickControls } from "./fit-quick-controls";

const VIDEO = { supported_endpoint_types: ["openai-video"] };
const OPENAI_IMAGE = { supported_endpoint_types: ["image-generation", "image-edits"], tags: "图像生成" };
const GEMINI_IMAGE = { supported_endpoint_types: ["gemini", "openai"], tags: "图像生成,Gemini" };

function card(model_name: string, extra: Partial<PricingModel> = VIDEO) {
    const profile = buildModelProfile({ model_name, ...extra });
    assert.ok(profile, model_name);
    return profile;
}

async function controlsOf(model: string, config: FitValuesConfig, extra?: Partial<PricingModel>) {
    const profile = card(model, extra);
    const values = await canvasToFitValues(profile, config, "");
    return { profile, values, controls: fitQuickControls(profile, values, config.fitAdvanced) };
}

const summary = (controls: Awaited<ReturnType<typeof controlsOf>>["controls"]) => controls.map(({ label, key, value }) => ({ label, key, value }));

test("底部快捷栏改用 fit 卡片的选项：清晰度、画幅、时长；选中的就是真正发出去的值", async () => {
    const { controls, values } = await controlsOf("seedance2.0 SEA", { vquality: "720", size: "1280x720", videoSeconds: "8" });
    assert.deepEqual(summary(controls), [
        { label: "清晰度", key: "vquality", value: "720p" },
        { label: "画幅", key: "size", value: "16:9" },
        { label: "时长", key: "videoSeconds", value: "8" },
    ]);
    assert.deepEqual({ resolution: values.resolution, aspectRatio: values.aspectRatio, seconds: values.seconds }, { resolution: "720p", aspectRatio: "16:9", seconds: 8 });
    assert.deepEqual(controls[0].options, [
        { value: "480p", label: "480p" },
        { value: "720p", label: "720p" },
    ]);
    assert.ok(controls[1].options.some((option) => option.value === "adaptive" && option.label === "自适应"));
    assert.deepEqual(
        controls[2].options.map((option) => option.value),
        ["4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    );
    assert.equal(controls[2].options[0].label, "4 秒");
});

test("复现的几种换值都对上了：旧的 9:16(2k)、720 在 fit 卡上显示的就是 fit 实际会发的值", async () => {
    const gpt = await controlsOf("gpt-image-2", { size: "9:16-2k", quality: "high" }, OPENAI_IMAGE);
    assert.deepEqual(summary(gpt.controls), [{ label: "尺寸", key: "size", value: gpt.values.imageSize }]);
    assert.ok(gpt.controls[0].options.some((option) => option.value === "1152x2048"));
    const banana = await controlsOf("gemini-nano-banana-2.1", { size: "9:16-2k", quality: "medium" }, GEMINI_IMAGE);
    const tiers = fitPanel(banana.profile, banana.values).groups[0];
    assert.equal(banana.values.imageSize, "2K");
    assert.deepEqual(summary(banana.controls), [
        { label: "清晰度", key: "quality", value: tiers.options.find((option) => option.value === "2K")?.write },
        { label: "画幅", key: "size", value: banana.values.aspectRatio },
    ]);
    assert.deepEqual(
        banana.controls[0].options,
        tiers.options.map(({ write, label }) => ({ value: write, label })),
    );
    assert.deepEqual(
        banana.controls[0].options.map((option) => option.label),
        ["1K", "2K", "4K"],
    );
    const h3self = await controlsOf("minimax H3-self", { vquality: "720", size: "720x1280", videoSeconds: "6" });
    assert.deepEqual(
        h3self.controls[0].options.map((option) => option.value),
        ["480p竖", "768p竖", "480p横", "768p横"],
    );
    assert.equal(h3self.controls[0].value, h3self.values.resolution);
    assert.ok(!h3self.controls.some((control) => control.label === "画幅"));
});

test("档位时长只给档位，固定时长只有一项；高级参数（开关、画质）写进 fitAdvanced", async () => {
    const chovy = await controlsOf("seedance-2.0-mini-Chovy", { videoSeconds: "12" });
    assert.deepEqual(
        chovy.controls.find((control) => control.label === "时长")?.options.map((option) => option.value),
        ["5", "10", "15"],
    );
    const fixed = await controlsOf("seedance-2.0-mini-super", { videoSeconds: "6" });
    const seconds = fixed.controls.find((control) => control.label === "时长");
    assert.deepEqual({ value: seconds?.value, options: seconds?.options }, { value: "15", options: [{ value: "15", label: "15 秒" }] });

    const coke = await controlsOf("seedance2.0 coke", { fitAdvanced: { seed: 3 } });
    const face = coke.controls.find((control) => control.key === "fitAdvanced")!;
    assert.deepEqual(
        { label: face.label, value: face.value, options: face.options },
        {
            label: "人脸处理（默认关闭）",
            value: "false",
            options: [
                { value: "true", label: "开" },
                { value: "false", label: "关" },
            ],
        },
    );
    assert.deepEqual(face.write("true"), { seed: 3, face: true });
    assert.deepEqual(face.write("false"), { seed: 3 });
    const stable = await controlsOf("gpt-image-2-stable", { size: "2048x1152", quality: "high" }, OPENAI_IMAGE);
    const quality = stable.controls.find((control) => control.key === "fitAdvanced")!;
    assert.deepEqual({ label: quality.label, value: quality.value }, { label: "画质", value: "high" });
    assert.deepEqual(quality.write("low"), { quality: "low" });
});

test("每张代表卡的每个选项：写回画布配置后，按 canvasToFitValues 重新换算，下拉框选中的正是这一项", async () => {
    const cards: Array<[string, FitValuesConfig, Partial<PricingModel>?]> = [
        ["seedance2.0 SEA", { vquality: "720", size: "1280x720", videoSeconds: "8" }],
        ["wan3.0-video", { vquality: "480p", size: "16:9", videoSeconds: "6" }],
        ["minimax H3", {}],
        ["minimax H3-self", { vquality: "720" }],
        ["seedance-2.0-mini-Chovy", { videoSeconds: "12" }],
        ["seedance2.0 coke", {}],
        ["gpt-image-2", { size: "auto" }, OPENAI_IMAGE],
        ["gpt-image-2-stable", { size: "2048x1152", quality: "auto" }, OPENAI_IMAGE],
        ["gemini-nano-banana-2.1", { quality: "high", size: "16:9" }, GEMINI_IMAGE],
    ];
    let checked = 0;
    for (const [model, config, extra] of cards) {
        const { profile, controls } = await controlsOf(model, config, extra);
        for (const control of controls) {
            for (const option of control.options) {
                const next = { ...config, [control.key]: control.write(option.value) } as FitValuesConfig;
                const again = fitQuickControls(profile, await canvasToFitValues(profile, next, ""), next.fitAdvanced);
                assert.equal(again.find((item) => item.label === control.label)?.value, option.value, `${model} ${control.label} ${option.label}`);
                checked += 1;
            }
        }
    }
    assert.ok(checked > 60, String(checked));
});
