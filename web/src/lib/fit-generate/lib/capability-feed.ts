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
import type {
  ModelProfile,
  ReferenceAssetKind,
  ReferenceLimits,
} from '../types'
import {
  canonicalAdvanced,
  canonicalSeconds,
  type CanonicalCapability,
} from './canonical-capabilities'

export type CapabilityFeedEntry = Readonly<Record<string, unknown>> & {
  readonly id: string
}

export type CapabilityFeed = {
  revision: string
  models: CapabilityFeedEntry[]
}

export type CapabilityLookup = ReadonlyMap<string, CapabilityFeedEntry>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

export function parseCapabilityFeed(payload: unknown): CapabilityFeed {
  if (!isRecord(payload) || !Array.isArray(payload.models)) {
    throw new Error('invalid model capability feed')
  }
  const models = payload.models.filter(
    (entry): entry is CapabilityFeedEntry =>
      isRecord(entry) && typeof entry.id === 'string' && entry.id !== ''
  )
  return {
    revision: typeof payload.revision === 'string' ? payload.revision : '',
    models,
  }
}

export function capabilityLookup(feed: CapabilityFeed): CapabilityLookup {
  return new Map(feed.models.map((entry) => [entry.id, entry]))
}

const PLACEHOLDER_FAMILY = 'unsupported'

export function hiddenByFeed(
  modelName: string,
  lookup: CapabilityLookup | null
): boolean {
  const entry = lookup?.get(modelName)
  if (!entry) return false
  const reviewedOrDeclared =
    typeof entry.family === 'string' &&
    entry.family !== '' &&
    entry.family !== PLACEHOLDER_FAMILY
  return (
    reviewedOrDeclared && entry.available === false && entry.visible !== false
  )
}

type KindField = 'maxImages' | 'maxVideos' | 'maxAudios'

type FeedMode = Record<KindField, number> & {
  maxTotal: number | null
  minImages: number
}

const KIND_FIELDS: Array<[ReferenceAssetKind, KindField]> = [
  ['image', 'maxImages'],
  ['video', 'maxVideos'],
  ['audio', 'maxAudios'],
]

const RESERVED_PARAMETER_KEYS = new Set([
  'model',
  'prompt',
  'metadata',
  'n',
  'seconds',
  'duration',
  'resolution',
  'ratio',
  'aspect_ratio',
  'size',
  'image_urls',
  'video_urls',
  'audio_urls',
])

const PARAMETER_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,59}$/

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function optionList(value: unknown): string[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const options = value.map((item) =>
    typeof item === 'string' ? item.trim() : ''
  )
  if (options.some((item) => item === '')) return null
  return [...new Set(options)]
}

function durationList(value: unknown): number[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const durations: number[] = []
  for (const item of value) {
    if (!isCount(item) || item === 0) return null
    if (!durations.includes(item)) durations.push(item)
  }
  return durations
}

function referenceModes(value: unknown): FeedMode[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const modes: FeedMode[] = []
  for (const mode of value) {
    if (!isRecord(mode) || typeof mode.id !== 'string') return null
    if (
      !isCount(mode.maxImages) ||
      !isCount(mode.maxVideos) ||
      !isCount(mode.maxAudios)
    ) {
      return null
    }
    if (mode.maxTotal !== undefined && !isCount(mode.maxTotal)) return null
    if (mode.minImages !== undefined && !isCount(mode.minImages)) return null
    modes.push({
      maxImages: mode.maxImages,
      maxVideos: mode.maxVideos,
      maxAudios: mode.maxAudios,
      maxTotal: isCount(mode.maxTotal) ? mode.maxTotal : null,
      minImages: isCount(mode.minImages) ? mode.minImages : 0,
    })
  }
  return modes
}

function parameterSchema(
  value: unknown
): NonNullable<CanonicalCapability['parameterSchema']> {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((field) => {
    if (!isRecord(field) || typeof field.key !== 'string') return []
    const key = field.key
    if (
      !PARAMETER_KEY_PATTERN.test(key) ||
      RESERVED_PARAMETER_KEYS.has(key) ||
      seen.has(key)
    ) {
      return []
    }
    seen.add(key)
    const options = Array.isArray(field.options)
      ? field.options.filter((item): item is string => typeof item === 'string')
      : undefined
    const fallback = field.default
    const hasDefault =
      typeof fallback === 'string' ||
      typeof fallback === 'number' ||
      typeof fallback === 'boolean'
    return [
      {
        key,
        label:
          typeof field.label === 'string' && field.label ? field.label : key,
        type: typeof field.type === 'string' ? field.type : 'text',
        ...(typeof field.min === 'number' ? { min: field.min } : {}),
        ...(typeof field.max === 'number' ? { max: field.max } : {}),
        ...(isCount(field.maxLength) ? { maxLength: field.maxLength } : {}),
        ...(options ? { options } : {}),
        ...(hasDefault ? { default: fallback } : {}),
      },
    ]
  })
}

function modeTotal(mode: FeedMode): number {
  return mode.maxTotal ?? mode.maxImages + mode.maxVideos + mode.maxAudios
}

function feedLimits(
  entry: CapabilityFeedEntry,
  modes: FeedMode[]
): ReferenceLimits | null {
  const caps: Record<ReferenceAssetKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
  }
  KIND_FIELDS.forEach(([kind, field]) => {
    const declared = entry[field]
    const bounds = [
      ...(isCount(declared) ? [declared] : []),
      ...(modes.length > 0
        ? [Math.max(...modes.map((mode) => mode[field]))]
        : []),
    ]
    caps[kind] = bounds.length > 0 ? Math.min(...bounds) : 0
  })
  const sum = caps.image + caps.video + caps.audio
  const total =
    modes.length > 0 ? Math.min(sum, Math.max(...modes.map(modeTotal))) : sum
  const minImages =
    modes.length > 0 && modes.every((mode) => mode.minImages > 0)
      ? Math.min(...modes.map((mode) => mode.minImages))
      : 0
  if (minImages > caps.image) return null
  return {
    ...caps,
    ...(minImages > 0 ? { minImages } : {}),
    referenceTotal: total,
    total,
    clipSeconds: null,
    clipSecondsRequired: [],
    totalClipSeconds: null,
    framesMixWithReferences: false,
    maxInlineBytes: null,
    hostedKinds: KIND_FIELDS.map(([kind]) => kind).filter(
      (kind) => caps[kind] > 0
    ),
  }
}

function namesOnlyV1Fields(entry: CapabilityFeedEntry): boolean {
  return (
    (entry.secondsField === undefined || entry.secondsField === 'seconds') &&
    (entry.aspectRatioField === undefined || entry.aspectRatioField === 'ratio')
  )
}

function declaredDefault(value: unknown, options: string[]) {
  return typeof value === 'string' && options.includes(value)
    ? value
    : undefined
}

export function feedVideoProfile(
  modelName: string,
  entry: CapabilityFeedEntry
): ModelProfile | null {
  if (
    entry.id !== modelName ||
    entry.kind !== 'video' ||
    entry.family !== 'url-lists' ||
    entry.available !== true ||
    !namesOnlyV1Fields(entry)
  ) {
    return null
  }
  const resolutions = optionList(entry.resolutions)
  const ratios = optionList(entry.ratios)
  const durations = durationList(entry.durations)
  const modes = referenceModes(entry.referenceModes)
  if (!resolutions || !ratios || !durations || !modes) return null

  const limits = feedLimits(entry, modes)
  if (!limits) return null
  const referenceTypes = [...limits.hostedKinds]

  const defaultDuration =
    isCount(entry.defaultDuration) && durations.includes(entry.defaultDuration)
      ? entry.defaultDuration
      : undefined
  const defaultResolution = declaredDefault(
    entry.defaultResolution,
    resolutions
  )
  const defaultAspectRatio = declaredDefault(entry.defaultRatio, ratios)
  const mediaLimits = isRecord(entry.mediaLimits) ? entry.mediaLimits : {}

  return {
    modelName,
    kind: 'video',
    imageApi: null,
    supportsImageEdit: false,
    seconds: canonicalSeconds(durations, defaultDuration),
    resolutions,
    ...(defaultResolution ? { defaultResolution } : {}),
    aspectRatioField: ratios.length > 0 ? 'ratio' : null,
    aspectRatios: ratios,
    ...(defaultAspectRatio ? { defaultAspectRatio } : {}),
    imageSizes: [],
    maxReferenceImages: limits.image,
    referenceField: null,
    referenceEncoding: 'data-url',
    referenceMode: 'url-lists',
    referenceTypes,
    roles: ['reference'],
    limits,
    advanced: canonicalAdvanced([], parameterSchema(entry.parameterSchema)),
    promptHintKey: null,
    promptMinLength: 0,
    promptNeedsCameraMotion: false,
    promptRulesMinSeconds: 0,
    padReferencesToRatio: false,
    audioNeedsVisual: mediaLimits.requireVisualWithAudio === true,
    secondsField: 'seconds',
  }
}
