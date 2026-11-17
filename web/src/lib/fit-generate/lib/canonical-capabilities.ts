// 由 sync-fit-generate 生成（已删去原注释），勿手改；更新用 bun run sync:fit，来源见 SOURCE.json
import contracts from '../model-capabilities.json'
import type {
  AdvancedParam,
  ModelProfile,
  ReferenceLimits,
  SecondsRule,
} from '../types'

export type CanonicalCapability = {
  id: string
  kind: 'image' | 'video'
  family: string
  resolutions: string[]
  ratios: string[]
  durations: number[]
  defaultDuration?: number
  maxImages: number
  maxVideos: number
  maxAudios: number
  pixelSizes?: Record<string, Record<string, string>>
  promptMaxLength?: number
  referenceModes: Array<{
    id: string
    maxImages: number
    maxVideos: number
    maxAudios: number
    maxTotal?: number
  }>
  parameterSchema?: Array<{
    key: string
    label: string
    type: string
    min?: number
    max?: number
    maxLength?: number
    options?: string[]
    default?: string | number | boolean
  }>
}

const capabilities = contracts as unknown as CanonicalCapability[]

function orderedOptions(existing: string[], supported: string[]): string[] {
  const allowed = new Set(supported.map((value) => value.toLowerCase()))
  const retained = existing.filter((value) => allowed.has(value.toLowerCase()))
  const seen = new Set(retained.map((value) => value.toLowerCase()))
  return [
    ...retained,
    ...supported.filter((value) => !seen.has(value.toLowerCase())),
  ]
}

export function canonicalCapability(id: string) {
  return capabilities.find((entry) => entry.id === id)
}

export function canonicalAdvanced(
  existing: AdvancedParam[],
  schema: CanonicalCapability['parameterSchema']
): AdvancedParam[] {
  return (schema ?? []).map((field): AdvancedParam => {
    const old = existing.find((entry) => entry.key === field.key)
    const labelKey = old?.labelKey ?? field.label
    if (field.type === 'boolean') {
      return {
        key: field.key,
        kind: 'boolean',
        labelKey,
        ...(old?.kind === 'boolean' && old.defaultValue != null
          ? { defaultValue: old.defaultValue }
          : {}),
      }
    }
    if (field.type === 'number') {
      return {
        key: field.key,
        kind: 'integer',
        labelKey,
        min: field.min ?? 0,
        max: field.max ?? Number.MAX_SAFE_INTEGER,
      }
    }
    if (field.type === 'select') {
      return {
        key: field.key,
        kind: 'choice',
        labelKey,
        options: (field.options ?? []).map((value) => ({
          value,
          labelKey:
            old?.kind === 'choice'
              ? (old.options.find((option) => option.value === value)
                  ?.labelKey ?? value)
              : value,
        })),
        defaultValue: String(field.default ?? field.options?.[0] ?? ''),
      }
    }
    return {
      key: field.key,
      kind: 'text',
      labelKey,
      maxLength: field.maxLength ?? 2000,
    }
  })
}

export function canonicalSeconds(
  durations: number[],
  defaultDuration?: number
): SecondsRule | null {
  if (durations.length === 0) return null
  if (durations.length === 1) return { mode: 'fixed', value: durations[0] }
  const sorted = [...new Set(durations)].sort((a, b) => a - b)
  const min = Math.min(...sorted)
  const max = Math.max(...sorted)
  const defaultValue = defaultDuration ?? durations[0]
  return sorted.length === max - min + 1
    ? { mode: 'range', min, max, defaultValue }
    : { mode: 'range', min, max, defaultValue, steps: sorted }
}

export function applyCanonicalCapability(
  profile: ModelProfile,
  override?: CanonicalCapability
): ModelProfile {
  const spec = override ?? canonicalCapability(profile.modelName)
  if (!spec) return profile
  const limits: ReferenceLimits = {
    ...profile.limits,
    image: spec.maxImages,
    video: spec.maxVideos,
    audio: spec.maxAudios,
    total: Math.max(
      0,
      ...spec.referenceModes.map(
        (mode) =>
          mode.maxTotal ?? mode.maxImages + mode.maxVideos + mode.maxAudios
      )
    ),
    referenceTotal: Math.max(
      0,
      ...spec.referenceModes
        .filter((mode) => mode.id === 'mixed' || mode.id === 'multi')
        .map(
          (mode) =>
            mode.maxTotal ?? mode.maxImages + mode.maxVideos + mode.maxAudios
        )
    ),
  }
  const result = {
    ...profile,
    limits,
    maxReferenceImages: spec.maxImages,
    advanced: canonicalAdvanced(profile.advanced, spec.parameterSchema),
  }
  if (spec.kind === 'image') {
    if (profile.imageApi === 'gemini-image') {
      return {
        ...result,
        imageSizes: orderedOptions(profile.imageSizes, spec.resolutions),
        aspectRatios: orderedOptions(profile.aspectRatios, spec.ratios),
      }
    }
    const sizes = Object.values(spec.pixelSizes ?? {}).flatMap((values) =>
      Object.values(values)
    )
    return {
      ...result,
      imageSizes: [
        ...(profile.imageSizes.includes('auto') ? ['auto'] : []),
        ...orderedOptions(profile.imageSizes, [...new Set(sizes)]),
      ],
    }
  }
  const seconds = canonicalSeconds(spec.durations, spec.defaultDuration)
  if (seconds) result.seconds = seconds
  result.resolutions = orderedOptions(profile.resolutions, spec.resolutions)
  if (profile.aspectRatioField) {
    result.aspectRatios = orderedOptions(profile.aspectRatios, spec.ratios)
  }
  return result
}
