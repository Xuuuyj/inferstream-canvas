import type { AdvancedValues, GenerationFormValues, ModelProfile } from "@/lib/fit-generate/types";
import { fitAdvancedPatch, fitPanel, type FitChoice, type FitPanelKey } from "@/lib/fit-panel";

/** 一个快捷下拉框：options 的 value 就是选中后写回画布配置的值，write 换算成要写进 key 的值（fitAdvanced 写整个对象）。 */
export type FitQuickControl = { label: string; key: FitPanelKey; value: string; options: Array<{ value: string; label: string }>; write: (value: string) => string | AdvancedValues };

const SWITCH: FitChoice[] = [
    { value: "true", label: "开", write: "true" },
    { value: "false", label: "关", write: "false" },
];

/** 当前值对不上任何选项时多给一个「默认」（写空值，由卡片默认值决定），下拉框不会显示一个其实没选中的值。 */
function control(label: string, key: FitPanelKey, current: string | null | undefined, choices: FitChoice[], write: FitQuickControl["write"] = (value) => value): FitQuickControl {
    const selected = choices.find((choice) => choice.value === current);
    const options = choices.map((choice) => ({ value: choice.write, label: choice.label }));
    return { label, key, value: selected?.write ?? "", options: selected ? options : [{ value: "", label: "默认" }, ...options], write };
}

/**
 * 视频、图片工作台「底部」布局那一排快捷下拉框，和 FitSettingsPanel 用同一份 fitPanel：清晰度、画幅或尺寸（Gemini 是清晰度档位加画幅）、
 * 时长（固定时长只有一项）、客户可选的高级参数。values 是 canvasToFitValues 换算出的、真正会发出去的表单值，下拉框选中的就是它。
 */
export function fitQuickControls(profile: ModelProfile, values: GenerationFormValues, advanced?: AdvancedValues): FitQuickControl[] {
    const panel = fitPanel(profile, values);
    const { seconds } = panel;
    const secondOptions = !seconds ? [] : seconds.mode === "fixed" ? [seconds.value] : seconds.mode === "steps" ? seconds.options : Array.from({ length: seconds.max - seconds.min + 1 }, (_, index) => seconds.min + index);
    return [
        ...panel.groups.map((group) => control(group.title, group.key, group.value, group.options)),
        ...(seconds
            ? [
                  control(
                      "时长",
                      "videoSeconds",
                      String(seconds.value),
                      secondOptions.map((value) => ({ value: String(value), label: `${value} 秒`, write: String(value) })),
                  ),
              ]
            : []),
        ...panel.advanced.map((item) => {
            const boolean = item.param.kind === "boolean";
            return control(item.label, "fitAdvanced", item.value === undefined ? undefined : String(item.value), boolean ? SWITCH : item.options, (value) => fitAdvancedPatch(profile, advanced, item.param.key, boolean ? value === "true" : value));
        }),
    ];
}
