/**
 * 手写垫片，代替 fit 的 react-i18next / i18next（sync-fit-generate 把同步副本里的导入改指到这里）。
 * 画布只有中文：按 fit 的 zh 文案（messages.zh.json）翻译，{{x}} 插值；没有译文的键原样返回，和 i18next 缺译文时一样。
 */
import messages from "../messages.zh.json";

const zh = messages as Record<string, string>;

export type TFunction = (key: string, options?: Record<string, unknown>) => string;

export const t: TFunction = (key, options) => (zh[key] ?? key).replace(/\{\{(\w+)\}\}/g, (match, name: string) => (options?.[name] == null ? match : String(options[name])));

export function useTranslation() {
    return { t };
}
