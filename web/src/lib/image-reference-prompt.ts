import type { ReferenceImage } from "@/types/image";

export const IMAGE_MASK_EDIT_PROMPT_PREFIX = "参考图中蓝色高亮覆盖区域是需要修改的位置，蓝色只是编辑标记，不要保留在最终图像中。只修改蓝色高亮区域，其他区域的构图、人物、文字、光影和风格保持不变。修改要求：";

/** 局部编辑的提示词是「固定前缀 + 用户写的修改要求」；面板只显示后一半，前缀折叠成标签。 */
export function isMaskEditPrompt(prompt?: string) {
    return Boolean(prompt?.startsWith(IMAGE_MASK_EDIT_PROMPT_PREFIX));
}

export function stripMaskEditPrefix(prompt: string) {
    return isMaskEditPrompt(prompt) ? prompt.slice(IMAGE_MASK_EDIT_PROMPT_PREFIX.length) : prompt;
}

export function withMaskEditPrefix(prompt: string) {
    return isMaskEditPrompt(prompt) ? prompt : `${IMAGE_MASK_EDIT_PROMPT_PREFIX}${prompt}`;
}

export function imageReferenceLabel(index: number) {
    return `图片${index + 1}`;
}

export function buildImageReferencePromptText(prompt: string, references: ReferenceImage[]) {
    const text = prompt.trim();
    if (!references.length) return text;
    const labels = references.map((_, index) => imageReferenceLabel(index));
    return `参考图片编号：${labels.join("、")}。请按这些编号理解提示词中的图片引用。\n\n${text}`;
}
