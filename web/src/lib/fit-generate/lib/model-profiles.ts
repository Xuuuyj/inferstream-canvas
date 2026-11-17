// 由 sync-fit-generate 生成（已删去原注释），勿手改；更新用 bun run sync:fit，来源见 SOURCE.json
/*
Copyright (C) 2023-2026 QuantumNous

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as
published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

For commercial licensing, please contact support@quantumnous.com
*/
import { parseTags } from '../shims/pricing-filters'
import type { PricingModel } from '../shims/pricing-types'

import {
  CUSTOMER_ADVANCED_KEYS,
  DEFAULT_ASPECT_RATIOS,
  GEMINI_IMAGE_SIZES,
  GEMINI_MAX_REFERENCE_IMAGES,
  IMAGE_EDIT_VERIFIED,
  KNOWN_VIDEO_RULES,
  NO_REFERENCE_LIMITS,
  OPENAI_IMAGE_SIZES_1K,
  OPENAI_IMAGE_SIZES_2K,
  OPENAI_IMAGE_SIZES_CODEX_1K,
  OPENAI_IMAGE_SIZES_2K_4K,
  OPENAI_IMAGE_SIZES_DEFAULT,
  OPENAI_IMAGE_SIZES_CODEX,
  OPENAI_IMAGE_SIZES_AUTO,
  OPENAI_IMAGE_SIZES_CODEX_MAX,
  OPENAI_IMAGE_SIZES_FULL,
  OPENAI_IMAGE_REFERENCE_CAP,
  OPENAI_IMAGE_REFERENCE_CAP_CODEX,
  AUTO_SIZE_IMAGE_MODELS,
  AUTO_SIZE_IMAGE_REFERENCE_CAP,
  UNIFIED_IMAGE_MODEL,
  UNIFIED_IMAGE_MODELS,
  UNIFIED_IMAGE_SIZES,
} from '../constants'
import type {
  AdvancedParam,
  AdvancedValues,
  GenerationKind,
  ModelProfile,
  ReferenceLimits,
  SecondsRule,
  StudioModel,
} from '../types'
import {
  applyCanonicalCapability,
  canonicalCapability,
} from './canonical-capabilities'
import {
  feedVideoProfile,
  hiddenByFeed,
  type CapabilityFeedEntry,
  type CapabilityLookup,
} from './capability-feed'

const IMAGE_TAGS = new Set([
  '图像生成',
  '图片生成',
  'image',
  'image-generation',
])

function schemaEnum(model: PricingModel, field: string): string[] {
  const values = model.billing_usage_schema?.[field]?.enum
  return Array.isArray(values)
    ? values.filter((v) => typeof v === 'string')
    : []
}

export function getGenerationKind(model: PricingModel): GenerationKind | null {
  const endpoints = model.supported_endpoint_types ?? []
  if (Object.hasOwn(KNOWN_VIDEO_RULES, model.model_name)) return 'video'
  if (endpoints.includes('openai-video')) return 'video'
  if (
    endpoints.includes('image-generation') ||
    endpoints.includes('image-edits')
  ) {
    return 'image'
  }
  if (endpoints.includes('gemini')) {
    const tags = parseTags(model.tags).map((tag) => tag.toLowerCase())
    const looksLikeImage =
      model.model_name.toLowerCase().includes('image') ||
      tags.some((tag) => IMAGE_TAGS.has(tag))
    if (looksLikeImage) return 'image'
  }
  return null
}

function fixedSecondsFromName(modelName: string): SecondsRule | null {
  const match = /-(\d{1,2})s$/i.exec(modelName)
  if (!match) return null
  return { mode: 'fixed', value: Number(match[1]) }
}

function openAiReferenceCap(modelName: string): number {
  if (UNIFIED_IMAGE_MODELS.has(modelName)) return 10
  if (AUTO_SIZE_IMAGE_MODELS.has(modelName)) {
    return AUTO_SIZE_IMAGE_REFERENCE_CAP
  }
  return modelName.toLowerCase().includes('codex')
    ? OPENAI_IMAGE_REFERENCE_CAP_CODEX
    : OPENAI_IMAGE_REFERENCE_CAP
}

function openAiImageSizes(modelName: string): string[] {
  if (UNIFIED_IMAGE_MODELS.has(modelName)) return UNIFIED_IMAGE_SIZES
  if (AUTO_SIZE_IMAGE_MODELS.has(modelName)) return OPENAI_IMAGE_SIZES_AUTO
  const name = modelName.toLowerCase()
  if (name === 'gpt-image-2') return OPENAI_IMAGE_SIZES_FULL
  if (name === 'gpt-image-2-codex') return OPENAI_IMAGE_SIZES_CODEX
  if (name === 'gpt-image-2-codex-max') return OPENAI_IMAGE_SIZES_CODEX_MAX
  if (name.includes('codex') && name.includes('2k')) {
    return OPENAI_IMAGE_SIZES_2K
  }
  if (name.includes('codex') && name.endsWith('-1k')) {
    return OPENAI_IMAGE_SIZES_CODEX_1K
  }
  if (name.includes('2k-4k') || name.endsWith('-2k') || name.endsWith('-4k')) {
    return OPENAI_IMAGE_SIZES_2K_4K
  }
  if (name.endsWith('-1k')) return OPENAI_IMAGE_SIZES_1K
  return OPENAI_IMAGE_SIZES_DEFAULT
}

function buildVideoProfile(model: PricingModel): ModelProfile {
  const known = KNOWN_VIDEO_RULES[model.model_name]
  const schemaRatios = [
    ...schemaEnum(model, 'aspect_ratio'),
    ...schemaEnum(model, 'ratio'),
  ]
  const schemaResolutions = schemaEnum(model, 'resolution')

  let aspectRatioField: ModelProfile['aspectRatioField'] = null
  if (known) {
    aspectRatioField = known.aspectRatioField
  } else if (schemaEnum(model, 'aspect_ratio').length > 0) {
    aspectRatioField = 'aspect_ratio'
  } else if (schemaEnum(model, 'ratio').length > 0) {
    aspectRatioField = 'ratio'
  }

  let aspectRatios: string[] = known?.aspectRatios ?? []
  if (aspectRatioField) {
    if (schemaRatios.length > 0) aspectRatios = schemaRatios
    else aspectRatios = known?.aspectRatios ?? DEFAULT_ASPECT_RATIOS
  }
  let resolutions =
    schemaResolutions.length > 0
      ? schemaResolutions
      : (known?.resolutions ?? [])
  if (
    (model.model_name === 'seedance-2.5-omni' ||
      model.model_name === 'seedance-2.5-UU' ||
      model.model_name === 'seedance-2.5-pro' ||
      model.model_name === 'seedance-2-5-pro') &&
    known
  ) {
    resolutions = known.resolutions ?? []
    aspectRatios = known.aspectRatios ?? []
  }

  const limits: ReferenceLimits = known?.limits ?? NO_REFERENCE_LIMITS
  return {
    modelName: model.model_name,
    kind: 'video',
    imageApi: null,
    supportsImageEdit: false,
    seconds: known?.seconds ?? fixedSecondsFromName(model.model_name),
    videoSize: known?.videoSize,
    videoSizeByAspectRatio: known?.videoSizeByAspectRatio,
    requiresFirstFrame: known?.requiresFirstFrame,
    secondsAsString: known?.secondsAsString,
    resolutions,
    aspectRatioField,
    aspectRatios,
    imageSizes: [],
    maxReferenceImages: limits.total,
    referenceField: null,
    referenceEncoding: known?.referenceEncoding ?? 'data-url',
    referenceMode: known?.referenceMode ?? 'none',
    referenceTypes: known?.referenceTypes ?? [],
    roles: known?.roles ?? [],
    limits,
    advanced: known?.advanced ?? [],
    promptHintKey: known?.promptHintKey ?? null,
    promptMinLength: known?.promptMinLength ?? 0,
    promptNeedsCameraMotion: known?.promptNeedsCameraMotion ?? false,
    promptRulesMinSeconds: known?.promptRulesMinSeconds ?? 0,
    padReferencesToRatio: known?.padReferencesToRatio ?? false,
    audioNeedsVisual: known?.audioNeedsVisual ?? false,
    secondsField: known?.secondsField ?? 'duration',
    ...(known?.resolutionRules
      ? { resolutionRules: known.resolutionRules }
      : {}),
  }
}

export function secondsRuleAt(
  profile: ModelProfile,
  resolution: string | null | undefined
): SecondsRule | null {
  const rule = profile.seconds
  const atResolution = resolution
    ? profile.resolutionRules?.[resolution]
    : undefined
  if (rule?.mode !== 'range' || !atResolution) return rule
  const min = Math.min(
    Math.max(atResolution.minSeconds ?? rule.min, rule.min),
    rule.max
  )
  const max = Math.max(
    Math.min(atResolution.maxSeconds ?? rule.max, rule.max),
    min
  )
  if (min === rule.min && max === rule.max) return rule
  return {
    ...rule,
    min,
    max,
    defaultValue: Math.min(Math.max(rule.defaultValue, min), max),
    ...(rule.steps
      ? { steps: rule.steps.filter((value) => value >= min && value <= max) }
      : {}),
  }
}

export function aspectRatiosAt(
  profile: ModelProfile,
  resolution: string | null | undefined
): string[] {
  const allowed = resolution
    ? profile.resolutionRules?.[resolution]?.aspectRatios
    : undefined
  if (!allowed) return profile.aspectRatios
  return profile.aspectRatios.filter((ratio) => allowed.includes(ratio))
}

function singleImageLimits(max: number): ReferenceLimits {
  return {
    image: max,
    video: 0,
    audio: 0,
    referenceTotal: max,
    total: max,
    clipSeconds: null,
    clipSecondsRequired: [],
    totalClipSeconds: null,
    framesMixWithReferences: false,
    maxInlineBytes: null,
    hostedKinds: [],
  }
}

function buildImageProfile(model: PricingModel): ModelProfile {
  const endpoints = model.supported_endpoint_types ?? []
  const isOpenAi =
    endpoints.includes('image-generation') || endpoints.includes('image-edits')

  if (!isOpenAi) {
    return {
      modelName: model.model_name,
      kind: 'image',
      imageApi: 'gemini-image',
      supportsImageEdit: false,
      seconds: null,
      resolutions: [],
      aspectRatioField: 'gemini',
      aspectRatios: DEFAULT_ASPECT_RATIOS,
      imageSizes: GEMINI_IMAGE_SIZES,
      maxReferenceImages: GEMINI_MAX_REFERENCE_IMAGES,
      referenceField: 'inline_data',
      referenceEncoding: 'raw-base64',
      referenceMode: 'gemini-parts',
      referenceTypes: ['image'],
      roles: ['reference'],
      limits: singleImageLimits(GEMINI_MAX_REFERENCE_IMAGES),
      advanced: [],
      promptHintKey: null,
      promptMinLength: 0,
      promptNeedsCameraMotion: false,
      promptRulesMinSeconds: 0,
      padReferencesToRatio: false,
      audioNeedsVisual: false,
      secondsField: 'duration',
    }
  }

  const supportsImageEdit =
    endpoints.includes('image-edits') ||
    UNIFIED_IMAGE_MODELS.has(model.model_name) ||
    IMAGE_EDIT_VERIFIED.has(model.model_name)
  return {
    modelName: model.model_name,
    kind: 'image',
    imageApi: 'openai-image',
    supportsImageEdit,
    ...(UNIFIED_IMAGE_MODELS.has(model.model_name)
      ? {
          imageEditTransport: 'json' as const,
          imageRequestDefaults: {
            ...(model.model_name === UNIFIED_IMAGE_MODEL
              ? { quality: 'medium' }
              : {}),
            response_format: 'b64_json',
          },
        }
      : {}),
    seconds: null,
    resolutions: [],
    aspectRatioField: null,
    aspectRatios: [],
    imageSizes: openAiImageSizes(model.model_name),
    maxReferenceImages: supportsImageEdit
      ? openAiReferenceCap(model.model_name)
      : 0,
    referenceField: supportsImageEdit ? 'image' : null,
    referenceEncoding: 'data-url',
    referenceMode: supportsImageEdit ? 'single-image' : 'none',
    referenceTypes: supportsImageEdit ? ['image'] : [],
    roles: supportsImageEdit ? ['reference'] : [],
    limits: supportsImageEdit
      ? singleImageLimits(openAiReferenceCap(model.model_name))
      : NO_REFERENCE_LIMITS,
    advanced: [],
    promptHintKey: null,
    promptMinLength: 0,
    promptNeedsCameraMotion: false,
    promptRulesMinSeconds: 0,
    padReferencesToRatio: false,
    audioNeedsVisual: false,
    secondsField: 'duration',
  }
}

function hasReviewedRules(modelName: string): boolean {
  return (
    Object.hasOwn(KNOWN_VIDEO_RULES, modelName) ||
    canonicalCapability(modelName) != null
  )
}

export function buildModelProfile(
  model: PricingModel,
  feedEntry?: CapabilityFeedEntry
): ModelProfile | null {
  const kind = getGenerationKind(model)
  if (kind === 'video') {
    const declared =
      feedEntry && !hasReviewedRules(model.model_name)
        ? feedVideoProfile(model.model_name, feedEntry)
        : null
    return declared ?? applyCanonicalCapability(buildVideoProfile(model))
  }
  if (kind === 'image') {
    return applyCanonicalCapability(buildImageProfile(model))
  }
  return null
}

function feedMayShape(model: PricingModel): boolean {
  return (
    getGenerationKind(model) === 'video' && !hasReviewedRules(model.model_name)
  )
}

export type StudioModelsOptions = {
  feedPending?: boolean
}

export function buildStudioModels(
  models: PricingModel[],
  lookup: CapabilityLookup | null,
  options: StudioModelsOptions = {}
): StudioModel[] {
  const waiting = options.feedPending === true && lookup == null
  return models
    .flatMap((model) => {
      if (waiting && feedMayShape(model)) return []
      if (hiddenByFeed(model.model_name, lookup)) return []
      const profile = buildModelProfile(model, lookup?.get(model.model_name))
      return profile ? [{ model, profile }] : []
    })
    .sort((a, b) => a.profile.modelName.localeCompare(b.profile.modelName))
}

export function customerAdvancedParams(profile: ModelProfile): AdvancedParam[] {
  return profile.advanced.filter((param) =>
    CUSTOMER_ADVANCED_KEYS.has(param.key)
  )
}

export function customerAdvancedValues(
  values: AdvancedValues | undefined
): AdvancedValues {
  return Object.fromEntries(
    Object.entries(values ?? {}).filter(([key]) =>
      CUSTOMER_ADVANCED_KEYS.has(key)
    )
  )
}

export function defaultFormValuesFor(profile: ModelProfile) {
  const resolution = profile.defaultResolution ?? profile.resolutions[0] ?? null
  const seconds = secondsRuleAt(profile, resolution)
  return {
    seconds: seconds?.mode === 'range' ? seconds.defaultValue : null,
    resolution,
    aspectRatio: profile.defaultAspectRatio ?? profile.aspectRatios[0] ?? null,
    imageSize: profile.imageSizes[0] ?? null,
    advanced: {},
  }
}
