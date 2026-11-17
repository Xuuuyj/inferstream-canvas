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
  AdvancedParam,
  ReferenceAssetKind,
  ReferenceEncoding,
  ReferenceLimits,
  ReferenceMode,
  ReferenceRole,
  ResolutionRule,
  SecondsRule,
} from './types'

export const VIDEO_POLL_INTERVAL_MS = 8000

export const CUSTOMER_ADVANCED_KEYS: ReadonlySet<string> = new Set([
  'quality',
  'ai_enhance',
  'face',
  'face_split',
])
export const MAX_POLL_FAILURES = 5
export const MAX_STORED_TASKS = 60
export const MAX_REFERENCE_BYTES = 10 * 1024 * 1024
export const MAX_REFERENCE_UPLOAD_BYTES = 40 * 1024 * 1024
export const MAX_REFERENCE_MEDIA_BYTES = 100 * 1024 * 1024

export const DEFAULT_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4']

export const CAMERA_MOTION_PATTERN =
  /(镜头|场景|推近|拉远|旋转|环绕|跟拍|特写|运镜|camera|pan|zoom|dolly|tracking)/i

export const OPENAI_IMAGE_SIZES_1K = [
  '1024x1024',
  '1024x1360',
  '1024x1536',
  '1024x1792',
  '1536x1024',
]
export const OPENAI_IMAGE_SIZES_2K_4K = [
  '2048x2048',
  '1536x2048',
  '2048x1536',
  '1152x2048',
  '2048x1152',
  '2880x2880',
  '2160x3840',
  '3840x2160',
]
export const OPENAI_IMAGE_SIZES_2K = OPENAI_IMAGE_SIZES_2K_4K.slice(0, 5)
export const UNIFIED_IMAGE_MODEL = 'gpt-image-2-1K-4K'
export const UNIFIED_IMAGE_MODELS: ReadonlySet<string> = new Set([
  UNIFIED_IMAGE_MODEL,
  'gpt-image-2-stable',
  'gpt-image-2.5-flare-stable',
  'gpt-image-2.5-sunburst-stable',
])
export const UNIFIED_IMAGE_SIZES = [
  '1024x1024',
  '1536x864',
  '864x1536',
  '1536x1152',
  '1152x1536',
  '1536x1024',
  '1024x1536',
  '2048x1152',
  '2048x2048',
  '1152x2048',
  '2048x1536',
  '1536x2048',
  '3840x2160',
  '2160x3840',
]
export const OPENAI_IMAGE_SIZES_CODEX_1K = ['1024x1024']
export const OPENAI_IMAGE_SIZES_DEFAULT = [
  'auto',
  '1024x1024',
  '1024x1360',
  '1024x1536',
  '1024x1792',
  '1536x1024',
]

export const IMAGE_SIZE_LABELS: Record<string, string> = {
  auto: 'auto（智能尺寸）',
  '1024x1024': '1:1（1024×1024）',
  '1024x1360': '3:4（1024×1360）',
  '1024x1536': '2:3（1024×1536）',
  '1024x1792': '9:16（1024×1792）',
  '1536x1024': '3:2（1536×1024）',
  '1536x864': '1K · 16:9（1536×864）',
  '864x1536': '1K · 9:16（864×1536）',
  '1536x1152': '1K · 4:3（1536×1152）',
  '1152x1536': '1K · 3:4（1152×1536）',
  '1080x1920': '9:16（1080×1920）',
  '1920x1080': '16:9（1920×1080）',
  '2048x2048': '2K · 1:1（2048×2048）',
  '1536x2048': '2K · 3:4（1536×2048）',
  '2048x1536': '2K · 4:3（2048×1536）',
  '1152x2048': '2K · 9:16（1152×2048）',
  '2048x1152': '2K · 16:9（2048×1152）',
  '2880x2880': '4K · 1:1（2880×2880）',
  '2160x3840': '4K · 9:16（2160×3840）',
  '3840x2160': '4K · 16:9（3840×2160）',
}

export function formatImageSizeOption(size: string): string {
  return IMAGE_SIZE_LABELS[size] ?? size
}
export const GEMINI_IMAGE_SIZES = ['1K', '2K', '4K']
export const GEMINI_MAX_REFERENCE_IMAGES = 14
export const OPENAI_IMAGE_SIZES_CODEX = [
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  ...OPENAI_IMAGE_SIZES_2K_4K.slice(0, 5),
]
export const OPENAI_IMAGE_SIZES_CODEX_MAX = [
  'auto',
  '1024x1024',
  '1024x1536',
  '1536x1024',
  '1080x1920',
  '1920x1080',
]
export const AUTO_SIZE_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'gpt-image-2.6-flare',
  'gpt-image-2.6-sunburst',
])
export const OPENAI_IMAGE_SIZES_AUTO = ['auto']
export const AUTO_SIZE_IMAGE_REFERENCE_CAP = 10
export const OPENAI_IMAGE_SIZES_FULL = [
  'auto',
  ...OPENAI_IMAGE_SIZES_1K,
  ...OPENAI_IMAGE_SIZES_2K_4K,
]
export const OPENAI_IMAGE_REFERENCE_CAP = 20
export const OPENAI_IMAGE_REFERENCE_CAP_CODEX = 17

export const IMAGE_EDIT_VERIFIED = new Set([
  'gpt-image-2',
  'gpt-image-2-codex',
  'gpt-image-2-1k',
  'gpt-image-2-2k-4k',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'gpt-image-2-codex-MAX',
])

export const NO_REFERENCE_LIMITS: ReferenceLimits = {
  image: 0,
  video: 0,
  audio: 0,
  referenceTotal: 0,
  total: 0,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: [],
}

const SEED: AdvancedParam = {
  key: 'seed',
  kind: 'integer',
  labelKey: 'Seed',
  min: 0,
  max: 2147483647,
}
const NEGATIVE_PROMPT: AdvancedParam = {
  key: 'negative_prompt',
  kind: 'text',
  labelKey: 'Negative prompt',
  maxLength: 500,
}

export type KnownVideoRule = {
  videoSize?: string
  videoSizeByAspectRatio?: Record<string, string>
  requiresFirstFrame?: boolean
  secondsAsString?: boolean
  seconds: SecondsRule | null
  aspectRatioField: 'ratio' | 'aspect_ratio' | null
  aspectRatios?: string[]
  resolutions?: string[]
  referenceMode: ReferenceMode
  referenceEncoding: ReferenceEncoding
  referenceTypes: ReferenceAssetKind[]
  roles: ReferenceRole[]
  limits: ReferenceLimits
  advanced: AdvancedParam[]
  promptHintKey?: string
  promptMinLength?: number
  promptMaxLength?: number
  promptNeedsCameraMotion?: boolean
  promptRulesMinSeconds?: number
  padReferencesToRatio?: boolean
  audioNeedsVisual?: boolean
  secondsField?: 'duration' | 'seconds'
  resolutionRules?: Record<string, ResolutionRule>
}

const fixed = (value: number): SecondsRule => ({ mode: 'fixed', value })
const range = (
  min: number,
  max: number,
  defaultValue: number,
  steps?: number[]
): SecondsRule =>
  steps
    ? { mode: 'range', min, max, defaultValue, steps }
    : { mode: 'range', min, max, defaultValue }

const H3_LIMITS: ReferenceLimits = {
  image: 9,
  video: 3,
  audio: 3,
  referenceTotal: 15,
  total: 15,
  clipSeconds: { min: 2, max: 15 },
  clipSecondsRequired: ['video'],
  totalClipSeconds: 15,
  framesMixWithReferences: true,
  maxInlineBytes: null,
  hostedKinds: ['image', 'video', 'audio'],
}

const H3_MAX_LIMITS: ReferenceLimits = {
  ...H3_LIMITS,
  image: 10,
  referenceTotal: 10,
  total: 10,
}

const SEEDANCE_ARRAY_LIMITS: ReferenceLimits = {
  image: 9,
  video: 0,
  audio: 0,
  referenceTotal: 9,
  total: 9,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: [],
}

const STABLE_LIMITS: ReferenceLimits = {
  image: 9,
  video: 3,
  audio: 3,
  referenceTotal: 12,
  total: 13,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: true,
  maxInlineBytes: null,
  hostedKinds: [],
}

const WAN_LIMITS: ReferenceLimits = {
  image: 10,
  video: 5,
  audio: 5,
  referenceTotal: 20,
  total: 20,
  clipSeconds: { min: 1, max: 15 },
  clipSecondsRequired: ['video', 'audio'],
  totalClipSeconds: 15,
  framesMixWithReferences: false,
  maxInlineBytes: 900 * 1024,
  hostedKinds: ['image', 'video', 'audio'],
}

const STABLE_ADVANCED: AdvancedParam[] = [
  { key: 'seed', kind: 'integer', labelKey: 'Seed', min: -1, max: 2147483647 },
  { key: 'generate_audio', kind: 'boolean', labelKey: 'Generate audio' },
  { key: 'watermark', kind: 'boolean', labelKey: 'Watermark' },
  { key: 'camera_fixed', kind: 'boolean', labelKey: 'Fixed camera' },
  { key: 'return_last_frame', kind: 'boolean', labelKey: 'Return last frame' },
]

const seedanceArrayRule = (
  seconds: number,
  family: 'fast' | '2.5'
): KnownVideoRule => ({
  seconds: fixed(seconds),
  aspectRatioField: 'ratio',
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  resolutions: ['720P'],
  referenceMode: family === '2.5' ? 'image-array-b64' : 'image-array-url',
  referenceEncoding: family === '2.5' ? 'raw-base64' : 'data-url',
  referenceTypes: ['image'],
  roles: ['reference'],
  limits: SEEDANCE_ARRAY_LIMITS,
  advanced: [SEED, NEGATIVE_PROMPT],
  promptHintKey: 'The first reference image is used as the first frame.',
  padReferencesToRatio: true,
})

const stable: KnownVideoRule = {
  seconds: range(4, 15, 5),
  aspectRatioField: 'ratio',
  aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4'],
  referenceMode: 'content',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'audio'],
  roles: ['first_frame', 'reference'],
  limits: { ...STABLE_LIMITS, video: 0 },
  advanced: STABLE_ADVANCED,
}

const officialSeedance = (seconds: SecondsRule): KnownVideoRule => ({
  ...stable,
  seconds,
  aspectRatios: ['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  referenceTypes: ['image', 'video', 'audio'],
  limits: {
    ...STABLE_LIMITS,
    framesMixWithReferences: false,
    hostedKinds: ['image', 'video', 'audio'],
  },
  advanced: STABLE_ADVANCED.filter((param) => param.key !== 'camera_fixed'),
})

const wan: KnownVideoRule = {
  seconds: range(2, 30, 5),
  aspectRatioField: 'ratio',
  aspectRatios: ['adaptive', '16:9', '4:3', '1:1', '3:4', '9:16'],
  resolutions: ['480P', '720P', '1080P'],
  referenceMode: 'media',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'video', 'audio'],
  roles: ['first_frame', 'last_frame', 'reference'],
  limits: WAN_LIMITS,
  advanced: [
    { key: 'prompt_extend', kind: 'boolean', labelKey: 'Prompt enhancement' },
  ],
  promptHintKey:
    'First/last frames cannot be combined with reference media. Video and audio references need a known length of 1-15 s (15 s in total per kind); reference videos must be at least 16 fps and not tiny. Uploaded files are hosted on this site and passed to the model as links.',
}

const wanTwoLines: KnownVideoRule = {
  ...wan,
  resolutions: ['480P', '720P'],
  referenceTypes: ['image', 'video', 'audio'],
  limits: WAN_LIMITS,
  resolutionRules: {
    '480P': { referenceVideo: false },
    '720P': { aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16'] },
  },
  promptHintKey:
    '480P: no reference video. 720P: up to 5 reference videos (not charged) and no adaptive ratio. Both run 2-30 s; a first frame (optionally with a last frame) cannot be combined with reference media. Video and audio clips need a known length of 1-15 s (15 s in total per kind). Uploaded files are hosted on this site and passed to the model as links.',
}

const PASSTHROUGH_SEEDANCE_LIMITS: ReferenceLimits = {
  image: 9,
  video: 3,
  audio: 3,
  referenceTotal: 15,
  total: 15,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: ['image', 'video', 'audio'],
}

const PASSTHROUGH_MINI_DEAL_LIMITS: ReferenceLimits = {
  image: 9,
  video: 0,
  audio: 3,
  referenceTotal: 12,
  total: 12,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: ['image', 'audio'],
}

const miniDealVideo: KnownVideoRule = {
  seconds: fixed(15),
  secondsField: 'seconds',
  aspectRatioField: 'ratio',
  aspectRatios: ['9:16', '16:9'],
  resolutions: ['720p'],
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'video', 'audio'],
  roles: ['reference'],
  limits: {
    ...PASSTHROUGH_MINI_DEAL_LIMITS,
    image: 9,
    video: 3,
    audio: 1,
    minImages: 1,
    referenceTotal: 13,
    total: 13,
    hostedKinds: ['image', 'video', 'audio'],
  },
  advanced: [],
  audioNeedsVisual: true,
  promptHintKey:
    'Fixed 720p, 15 s per call. 1-9 reference pictures are required, plus up to 3 reference videos and 1 audio clip. Dialogue subtitles may appear in the picture.',
}

const PASSTHROUGH_SEEDANCE_25_LARGE_LIMITS: ReferenceLimits = {
  image: 30,
  video: 0,
  audio: 10,
  referenceTotal: 40,
  total: 40,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: ['image', 'audio'],
}

const PASSTHROUGH_SEEDANCE_25_PRO_LIMITS: ReferenceLimits = {
  image: 30,
  video: 10,
  audio: 10,
  referenceTotal: 50,
  total: 50,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: ['image', 'video', 'audio'],
}

const FACE_IMAGE_LIMITS: ReferenceLimits = {
  image: 9,
  video: 0,
  audio: 0,
  referenceTotal: 9,
  total: 9,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: false,
  maxInlineBytes: null,
  hostedKinds: ['image'],
}

const FACE_VIDEO_SIZES = { '9:16': '720x1280', '16:9': '1280x720' }

const faceVideo = (seconds: SecondsRule): KnownVideoRule => ({
  seconds,
  secondsField: 'seconds',
  secondsAsString: true,
  videoSizeByAspectRatio: FACE_VIDEO_SIZES,
  aspectRatioField: null,
  aspectRatios: Object.keys(FACE_VIDEO_SIZES),
  resolutions: ['720p'],
  referenceMode: 'images-array',
  referenceEncoding: 'data-url',
  referenceTypes: ['image'],
  roles: ['reference'],
  limits: FACE_IMAGE_LIMITS,
  advanced: [],
  promptHintKey:
    'Up to 9 reference pictures. Uploaded pictures are hosted on this site and passed as secure links.',
})

const passthroughSeedance = (promptHintKey: string): KnownVideoRule => ({
  seconds: range(4, 15, 5),
  aspectRatioField: 'ratio',
  aspectRatios: ['16:9', '9:16', '1:1', '4:3'],
  resolutions: ['720p'],
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'video', 'audio'],
  roles: ['reference'],
  limits: PASSTHROUGH_SEEDANCE_LIMITS,
  advanced: [],
  promptHintKey,
  audioNeedsVisual: true,
})

const PASSTHROUGH_H3_2K_LIMITS: ReferenceLimits = {
  image: 9,
  video: 0,
  audio: 3,
  referenceTotal: 12,
  total: 14,
  clipSeconds: null,
  clipSecondsRequired: [],
  totalClipSeconds: null,
  framesMixWithReferences: true,
  maxInlineBytes: null,
  hostedKinds: ['image', 'audio'],
}

const fixedNoReferences = (seconds: number): KnownVideoRule => ({
  seconds: fixed(seconds),
  aspectRatioField: null,
  referenceMode: 'none',
  referenceEncoding: 'data-url',
  referenceTypes: [],
  roles: [],
  limits: NO_REFERENCE_LIMITS,
  advanced: [],
})

const fixedVideo = (
  seconds: number,
  size: string,
  frames = false
): KnownVideoRule => ({
  ...fixedNoReferences(seconds),
  secondsField: 'seconds',
  videoSize: size,
  secondsAsString: true,
  aspectRatios: [size === '1280x720' ? '16:9' : '9:16'],
  resolutions: [size === '1080x1920' ? '1080p' : '720p'],
  referenceMode: frames ? 'input-reference' : 'none',
  referenceTypes: frames ? ['image'] : [],
  roles: frames ? ['first_frame', 'last_frame'] : [],
  requiresFirstFrame: frames,
  limits: frames ? { ...NO_REFERENCE_LIMITS, total: 2 } : NO_REFERENCE_LIMITS,
  promptHintKey: frames
    ? 'This model requires a first frame image; a last frame is optional.'
    : undefined,
})

const fastDeal: KnownVideoRule = {
  seconds: range(5, 15, 15),
  secondsField: 'seconds',
  aspectRatioField: 'ratio',
  aspectRatios: DEFAULT_ASPECT_RATIOS,
  resolutions: ['720p'],
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'audio'],
  roles: ['reference'],
  limits: PASSTHROUGH_MINI_DEAL_LIMITS,
  advanced: [],
  padReferencesToRatio: true,
}

const seedance480 = (
  maxSeconds: number,
  maxImages: number,
  maxClips: number
): KnownVideoRule => ({
  seconds: range(4, maxSeconds, maxSeconds),
  secondsField: 'duration',
  aspectRatioField: 'ratio',
  aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4'],
  resolutions: ['480p'],
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'video', 'audio'],
  roles: ['reference'],
  limits: {
    ...NO_REFERENCE_LIMITS,
    image: maxImages,
    video: maxClips,
    audio: maxClips,
    referenceTotal: maxImages + maxClips * 2,
    total: maxImages + maxClips * 2,
    hostedKinds: ['image', 'video', 'audio'],
  },
  advanced: [SEED, NEGATIVE_PROMPT],
})

const seedance720 = (
  maxSeconds: number,
  maxImages: number,
  maxAudios: number
): KnownVideoRule => ({
  seconds: range(4, maxSeconds, maxSeconds),
  secondsField: 'seconds',
  aspectRatioField: 'ratio',
  aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'],
  resolutions: ['720p'],
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'audio'],
  roles: ['reference'],
  limits: {
    ...NO_REFERENCE_LIMITS,
    image: maxImages,
    audio: maxAudios,
    referenceTotal: maxImages + maxAudios,
    total: maxImages + maxAudios,
    hostedKinds: ['image', 'audio'],
  },
  advanced: [
    { key: 'face', kind: 'boolean', labelKey: 'Face processing (default off)' },
  ],
  promptHintKey:
    '720p. Reference audio is recommended as MP3; video references are not supported. Each reference must be 50 MB or smaller. Uploads are hosted on this site and sent as HTTPS links. Face processing is optional and off by default; its effect has not been verified with real-person references.',
})

const seedance720Fast: KnownVideoRule = {
  ...seedance720(15, 9, 3),
  promptHintKey:
    'A 15 s request returned a 14.08 s video in a live test; output length may be shorter than requested. 720p. Reference audio is recommended as MP3; video references are not supported. Each reference must be 50 MB or smaller. Uploads are hosted on this site and sent as HTTPS links. Face processing is optional and off by default; its effect has not been verified with real-person references.',
}

const SEA_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']
const SIX_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']

const picturesOnly = (
  seconds: SecondsRule,
  resolutions: string[],
  aspectRatios: string[],
  pictures: number
): KnownVideoRule => ({
  seconds,
  secondsField: 'seconds',
  aspectRatioField: 'ratio',
  aspectRatios,
  resolutions,
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image'],
  roles: ['reference'],
  limits: {
    ...NO_REFERENCE_LIMITS,
    image: pictures,
    referenceTotal: pictures,
    total: pictures,
    hostedKinds: ['image'],
  },
  advanced: [],
})

const irisVideo = (seconds: SecondsRule): KnownVideoRule => ({
  seconds,
  secondsField: 'seconds',
  aspectRatioField: 'ratio',
  aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9', 'adaptive'],
  resolutions: ['720p'],
  referenceMode: 'url-lists',
  referenceEncoding: 'data-url',
  referenceTypes: ['image', 'video', 'audio'],
  roles: ['reference'],
  limits: {
    ...NO_REFERENCE_LIMITS,
    image: 30,
    video: 10,
    audio: 10,
    referenceTotal: 50,
    total: 50,
    hostedKinds: ['image', 'video', 'audio'],
  },
  advanced: [],
})

const grokPreview: KnownVideoRule = {
  seconds: fixed(15),
  aspectRatioField: 'aspect_ratio',
  aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2'],
  resolutions: ['480p', '720p', '1080p'],
  referenceMode: 'grok-references',
  referenceEncoding: 'data-url',
  referenceTypes: ['image'],
  roles: ['first_frame', 'reference'],
  limits: {
    image: 7,
    video: 0,
    audio: 0,
    referenceTotal: 7,
    total: 7,
    clipSeconds: null,
    clipSecondsRequired: [],
    totalClipSeconds: null,
    framesMixWithReferences: true,
    maxInlineBytes: null,
    hostedKinds: [],
  },
  advanced: [],
}

export const KNOWN_VIDEO_RULES: Record<string, KnownVideoRule> = {
  'seedance 2.5-GT': {
    ...fixedNoReferences(5),
    seconds: range(4, 30, 5),
    resolutions: ['480p', '720p', '1080p'],
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive'],
    referenceMode: 'url-lists',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 30,
      video: 10,
      audio: 10,
      referenceTotal: 50,
      total: 50,
      clipSeconds: { min: 2, max: 30 },
      maxClipSecondsByKind: { video: 15 },
      clipSecondsRequired: ['video', 'audio'],
      totalClipSeconds: 30,
      totalClipSecondsByKind: { video: 15 },
      hostedKinds: ['image', 'video', 'audio'],
    },
    advanced: [
      {
        key: 'generate_audio',
        kind: 'boolean',
        labelKey: 'Generate audio',
        defaultValue: true,
      },
      {
        key: 'watermark',
        kind: 'boolean',
        labelKey: 'Watermark',
        defaultValue: false,
      },
      {
        key: 'return_last_frame',
        kind: 'boolean',
        labelKey: 'Return last frame',
        defaultValue: false,
      },
      {
        key: 'output_format',
        kind: 'choice',
        labelKey: 'Output format',
        options: [
          { value: 'mp4', labelKey: 'MP4' },
          { value: 'mov', labelKey: 'MOV' },
        ],
        defaultValue: 'mp4',
      },
    ],
    audioNeedsVisual: false,
  },
  'seedance2.0 SEA': picturesOnly(
    range(4, 15, 5),
    ['480p', '720p'],
    SEA_RATIOS,
    9
  ),
  'seedance2.0 fast SEA': picturesOnly(
    range(4, 15, 5),
    ['480p', '720p'],
    SEA_RATIOS,
    9
  ),
  'minimax H3 2K': picturesOnly(range(4, 15, 10), ['2K'], SEA_RATIOS, 9),
  'seedance2.5 Nova': picturesOnly(
    range(4, 30, 10),
    ['480p', '720p'],
    SIX_RATIOS,
    9
  ),
  'seedance2.5 Red': picturesOnly(range(4, 30, 30), ['720p'], SIX_RATIOS, 30),
  'seedance2.0 mini Mint': picturesOnly(
    range(4, 15, 15),
    ['480p'],
    ['9:16', '16:9'],
    1
  ),
  'seedance2.0 fast super': picturesOnly(fixed(10), ['720p'], SIX_RATIOS, 9),
  'seedance2.0 fast-super': picturesOnly(
    fixed(15),
    ['720p'],
    ['9:16', '16:9', '1:1'],
    10
  ),
  'seedance2.5 Iris': irisVideo(fixed(30)),
  'seedance2.5 Iris Flex': irisVideo(range(5, 30, 30)),
  'vidu-q4': {
    seconds: range(4, 16, 16),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p', '1080p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 15,
      audio: 3,
      referenceTotal: 18,
      total: 18,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
  },
  'seedance2.0 coke': seedance720Fast,
  'seedance2.5 Burger': seedance720(30, 30, 10),
  'seedance2.5 Star': { ...seedance720(30, 30, 10), seconds: fixed(30) },
  'seedance2.5 Vela': {
    ...seedance720(30, 30, 10),
    resolutions: ['480p', '720p', '1080p'],
    promptHintKey:
      '480p, 720p or 1080p, one price per clip by resolution. Reference audio is recommended as MP3; video references are not supported. Each reference must be 50 MB or smaller. Uploads are hosted on this site and sent as HTTPS links. Face processing is optional and off by default; its effect has not been verified with real-person references.',
  },
  'seedance-2.0-fast-720p': seedance720Fast,
  'seedance-2.5-720p': seedance720(30, 30, 10),
  'seedance2.5 Orca': {
    seconds: range(4, 30, 15),
    secondsField: 'duration',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p', '1080p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 30,
      video: 10,
      audio: 10,
      referenceTotal: 50,
      total: 50,
      hostedKinds: ['image', 'video', 'audio'],
    },
    resolutionRules: {
      '720p': { audioNeedsVisual: true },
      '1080p': { audioNeedsVisual: true },
    },
    advanced: [],
    promptMaxLength: 8000,
  },
  'YB-sd-2.5满血': {
    seconds: range(4, 30, 15),
    secondsField: 'duration',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      audio: 3,
      referenceTotal: 12,
      total: 12,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
    promptMaxLength: 8000,
  },
  'seedance-2.0-480': seedance480(15, 9, 3),
  'seedance 2.0 fast cheap': {
    seconds: range(4, 15, 15),
    secondsField: 'duration',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      audio: 3,
      referenceTotal: 12,
      total: 12,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
  },
  'seedance2.0 fast Luna': seedance480(15, 9, 3),
  'seedance2.0 fast Stella': {
    ...seedance480(15, 9, 3),
    resolutions: ['720p'],
  },
  'seedance-2.5-480p': seedance480(30, 30, 10),
  'seedance2.5 OvO': seedance480(30, 9, 3),
  'seedance2.5 Ultra': {
    seconds: range(4, 30, 5),
    secondsField: 'duration',
    aspectRatioField: 'aspect_ratio',
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 30,
      audio: 10,
      referenceTotal: 40,
      total: 40,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [
      {
        key: 'face_split',
        kind: 'boolean',
        labelKey: 'Face processing (default off)',
      },
    ],
    promptHintKey:
      '4–30 s at 720p only (480p and 1080p are paused). Face processing is off by default. Reference audio is documented but unverified; reference video is unavailable until its billing duration is verified.',
  },
  'seedance-2.5-Muse': {
    seconds: range(5, 30, 30, [5, 10, 15, 30]),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance-2.0-mini-Muse': {
    seconds: range(5, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance-2.0-mini-Chovy': picturesOnly(
    range(5, 15, 15, [5, 10, 15]),
    ['720p'],
    ['9:16', '16:9'],
    9
  ),
  'seedance-2.0-fast-Neko': picturesOnly(
    range(5, 15, 15, [5, 10, 15]),
    ['720p'],
    ['9:16', '16:9'],
    9
  ),
  'seedance-2.0-Neko': picturesOnly(
    range(5, 15, 15, [5, 10, 15]),
    ['720p'],
    ['9:16', '16:9'],
    9
  ),
  'seedance2.5 chovy': {
    seconds: fixed(30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0 chovy': {
    seconds: fixed(15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'sora-2': {
    seconds: fixed(8),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 1,
      referenceTotal: 1,
      total: 1,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance-2.5-UU': {
    seconds: fixed(30),
    aspectRatioField: 'ratio',
    aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 30,
      referenceTotal: 30,
      total: 30,
      hostedKinds: ['image'],
    },
    advanced: [
      {
        key: 'camera_movement',
        kind: 'choice',
        labelKey: 'Camera movement',
        options: [
          { value: 'auto', labelKey: 'Automatic camera movement' },
          { value: 'fixed', labelKey: 'Fixed camera' },
        ],
        defaultValue: 'auto',
      },
    ],
    promptMinLength: 1,
    promptMaxLength: 6000,
    promptHintKey:
      'Fixed 30 s at 720p. Use text only or up to 30 reference pictures. Video and audio references are not supported. Uploaded pictures are hosted on this site and passed as secure links.',
  },
  '特价seedance-2.5-720p': faceVideo(fixed(30)),
  'ah-seedance-2.0-face': faceVideo(range(4, 15, 5)),
  'seedance-2.5-omni': {
    seconds: range(4, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_SEEDANCE_25_LARGE_LIMITS,
    advanced: [],
    promptHintKey:
      '4-30 s at 720p only, 30 s by default. Use text only or up to 30 reference pictures and 10 audio clips; video references are not supported. Uploaded files are hosted on this site and passed to the model as links.',
  },
  'seedance-2.0-mini-Lyra': {
    seconds: range(4, 15, 5),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resolutions: ['480p', '720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_MINI_DEAL_LIMITS,
    advanced: [],
    promptHintKey:
      '4-15 s at 480p or 720p, 5 s by default, billed per second. Use text only or up to 9 reference pictures and 3 audio clips; video references are not supported. Uploaded files are hosted on this site and passed to the model as links.',
  },
  'seedance-2-5-pro': {
    seconds: range(4, 30, 5),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_SEEDANCE_25_LARGE_LIMITS,
    advanced: [],
    promptHintKey:
      'Choose 4–30 s at 480p. Supports up to 30 reference pictures and 10 audio clips; video references are not supported. Uploaded files are hosted on this site and passed to the model as links.',
  },
  'seedance-2.5-pro': {
    seconds: range(10, 30, 30),
    secondsField: 'seconds',
    secondsAsString: true,
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '21:9', '1:1'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_SEEDANCE_25_PRO_LIMITS,
    advanced: [],
    promptHintKey:
      'Choose 10–30 s at 720p. Supports up to 30 reference pictures, 10 reference videos and 10 audio clips. Uploaded files are hosted on this site and passed to the model as links.',
  },
  'seedance-2.0-fast-deal': fastDeal,
  'seedance-2.0-fast-super': fastDeal,
  'veo_3_1-fast-landscape': fixedVideo(8, '1280x720'),
  'veo_3_1-fast-portrait': fixedVideo(8, '720x1280'),
  'veo_3_1-fast-portrait-hd': fixedVideo(8, '1080x1920'),
  'veo_3_1-fast-fl-portrait': fixedVideo(8, '720x1280', true),
  'veo_3_1-fast-fl-portrait-hd': fixedVideo(8, '1080x1920', true),
  'veo_3_1-lite-fl-portrait': fixedVideo(8, '720x1280', true),
  'omni_flash-landscape-10s': fixedVideo(10, '1280x720'),
  'omni_flash-portrait-10s': fixedVideo(10, '720x1280'),
  'minimax H3': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9'],
    resolutions: ['480P'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
    padReferencesToRatio: true,
  },
  'minimax H3-MAX': {
    seconds: range(5, 15, 10),
    aspectRatioField: 'ratio',
    resolutions: ['480p', '768p'],
    referenceMode: 'h3',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['first_frame', 'last_frame', 'reference'],
    limits: H3_MAX_LIMITS,
    advanced: [SEED, NEGATIVE_PROMPT],
    padReferencesToRatio: true,
  },
  'minimax H3-self': {
    seconds: range(1, 15, 5),
    aspectRatioField: null,
    resolutions: ['480p竖', '768p竖', '480p横', '768p横'],
    referenceMode: 'numbered',
    referenceEncoding: 'raw-base64',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      image: 9,
      video: 0,
      audio: 0,
      referenceTotal: 9,
      total: 9,
      clipSeconds: null,
      clipSecondsRequired: [],
      totalClipSeconds: null,
      framesMixWithReferences: false,
      maxInlineBytes: null,
      hostedKinds: ['image'],
    },
    advanced: [
      {
        key: 'seed',
        kind: 'integer',
        labelKey: 'Seed',
        min: 1,
        max: 999999999999999,
      },
    ],
    promptHintKey: 'The first reference image is used as the first frame.',
  },
  'seedance-2.0-mini-stable': stable,
  'seedance-2.0-fast-stable': stable,
  'seedance2.0 mini Love': stable,
  'seedance2.0 fast Zeus': stable,
  'seedance2.0 Zeus': stable,
  'seedance2.0 mini stable': officialSeedance(range(4, 15, 5)),
  'seedance2.0 fast stable': officialSeedance(range(4, 15, 5)),
  'seedance 2.0 mini-GT': officialSeedance(range(10, 15, 15, [10, 15])),
  'seedance 2.0 fast-GT': officialSeedance(range(10, 15, 15, [10, 15])),
  'seedance 2.0 mini-OvO': officialSeedance(range(4, 15, 5)),
  'seedance 2.0 fast-OvO': officialSeedance(range(4, 15, 5)),
  'seedance 2.0 mini-OvO-Pack': officialSeedance(range(10, 15, 15, [10, 15])),
  'seedance 2.0 fast-OvO-Pack': officialSeedance(range(10, 15, 15, [10, 15])),
  'seedance-2.0-fast-5s': seedanceArrayRule(5, 'fast'),
  'seedance-2.0-fast-10s': seedanceArrayRule(10, 'fast'),
  'seedance-2.0-fast-15s': seedanceArrayRule(15, 'fast'),
  'seedance-2.5': {
    ...seedanceArrayRule(10, '2.5'),
    seconds: range(5, 30, 10),
    promptMinLength: 30,
    promptNeedsCameraMotion: true,
    promptRulesMinSeconds: 30,
    promptHintKey:
      'Any whole length from 5 to 30 s. Clips of 15 s fail noticeably more often, so prefer 10 or 20 s. A 30-second clip needs a prompt of at least 30 characters that describes camera motion. The first reference image is used as the first frame.',
  },
  'seedance-2.5-5s': seedanceArrayRule(5, '2.5'),
  'seedance-2.5-10s': seedanceArrayRule(10, '2.5'),
  'seedance-2.5-30s': {
    ...seedanceArrayRule(30, '2.5'),
    promptMinLength: 30,
    promptNeedsCameraMotion: true,
    promptHintKey:
      'The 30-second model needs a prompt of at least 30 characters that describes camera motion (push in, pull back, orbit, follow, pan, zoom). The first reference image is used as the first frame.',
  },
  'grok-imagine-video-1.5-preview': grokPreview,
  'grok-imagine-video': {
    ...grokPreview,
    seconds: range(1, 15, 6),
    secondsField: 'seconds',
    resolutions: ['480p', '720p'],
  },
  'grok-imagine-video-1.5': {
    ...grokPreview,
    seconds: range(1, 15, 6),
    secondsField: 'seconds',
    resolutionRules: { '1080p': { firstFrameOnly: true } },
  },
  'wan3.0-video': wanTwoLines,
  'wan3.0-video-prime': wan,
  'veo-3.1-fast': fixedNoReferences(8),
  'veo-3.1-lite': fixedNoReferences(8),
  'veo-3.1-fast-hd': fixedNoReferences(8),
  'omni-1.1-flash-10s': fixedNoReferences(10),
  'seedance2.0-mx-933': passthroughSeedance(
    'Reference pictures, videos and audio are numbered in upload order: refer to them in the prompt as @Image1, @Video1, @Audio1. Audio needs at least one picture or video. Uploaded files are hosted on this site and passed to the model as links.'
  ),
  'seedance2.0-mx': passthroughSeedance(
    'Reference pictures, videos and audio are numbered in upload order: refer to them in the prompt as @Image1, @Video1, @Audio1. Audio needs at least one picture or video. Uploaded files are hosted on this site and passed to the model as links. The video is H.265; if the preview does not play in this browser, download it.'
  ),
  'seedance2.5-903': passthroughSeedance(
    'Reference pictures guide the subject rather than fixing the first frame. Pictures, videos and audio are numbered in upload order: refer to them in the prompt as @Image1, @Video1, @Audio1. Audio needs at least one picture or video. Uploaded files are hosted on this site and passed to the model as links. The video is H.265; if the preview does not play in this browser, download it.'
  ),
  'MiniMaxH3-2K-903': {
    seconds: range(4, 15, 5),
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['2K'],
    referenceMode: 'h3-2k',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['first_frame', 'last_frame', 'reference'],
    limits: PASSTHROUGH_H3_2K_LIMITS,
    advanced: [
      { key: 'generate_audio', kind: 'boolean', labelKey: 'Generate audio' },
    ],
    promptHintKey:
      'Outputs about 2560×1440. First and last frames count toward the 9 pictures. Audio references need at least one picture; video references are not supported. Uploaded files are hosted on this site and passed to the model as links.',
    audioNeedsVisual: true,
  },
  'seedance-2.0-mini-super': miniDealVideo,
  'seedance-2.0-mini-cheap': miniDealVideo,
  'seedance-2.0-mini-deal': miniDealVideo,
  'seedance-2.0-super': {
    seconds: fixed(15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0 mini max': {
    seconds: range(5, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.5 cheap': {
    seconds: range(4, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.5 Arcturus': {
    seconds: range(4, 12, 5),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '4:3', '3:4', '1:1'],
    resolutions: ['720p', '480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      video: 3,
      audio: 3,
      referenceTotal: 15,
      total: 15,
      hostedKinds: ['image', 'video', 'audio'],
    },
    resolutionRules: { '720p': { maxSeconds: 5 } },
    advanced: [],
    promptMaxLength: 10000,
  },
  'Wan3.0-Nova': {
    seconds: range(5, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '4:3', '3:4', '1:1'],
    resolutions: ['480p', '720p', '1080p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      audio: 5,
      referenceTotal: 15,
      total: 15,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
  },
  'Wan3.0-Vega': {
    seconds: range(5, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '4:3', '3:4', '1:1'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      audio: 5,
      referenceTotal: 15,
      total: 15,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
  },
  'Wan3.0-super': {
    seconds: null,
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      audio: 5,
      referenceTotal: 15,
      total: 15,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
    promptHintKey:
      '480p only, fixed at 20 s. Up to 10 reference pictures and 5 audio clips; video references are not supported. Uploaded files are hosted on this site and passed to the model as links.',
  },
  'Wan3.0-cheap': {
    seconds: fixed(20),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      video: 5,
      audio: 5,
      referenceTotal: 20,
      total: 20,
      clipSeconds: { min: 1, max: 15 },
      clipSecondsRequired: ['video', 'audio'],
      totalClipSeconds: 15,
      combinedClipSeconds: 15,
      hostedKinds: ['image', 'video', 'audio'],
    },
    advanced: [],
    promptHintKey:
      '480p only, fixed at 20 s. Up to 10 reference pictures, 5 video clips and 5 audio clips; video and audio clips need a known length and may add up to 15 s at most together. Uploaded files are hosted on this site and passed to the model as links.',
  },
  'seedance2.5 max': {
    seconds: fixed(30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p', '720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0 fast max': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.5 Rigel': {
    seconds: range(4, 25, 25),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0 Rigel': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p', '720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0 fast Rigel': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p', '720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0 mini Rigel': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p', '720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.5 Polaris': {
    seconds: range(15, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_MINI_DEAL_LIMITS,
    advanced: [],
  },
  'seedance2.5 Altair': seedance720(30, 30, 10),
  'minimax H3 2K Sirius': picturesOnly(
    range(4, 15, 15),
    ['2K'],
    ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    9
  ),
  'minimax H3 Turbo': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4'],
    resolutions: ['480p'],
    referenceMode: 'none',
    referenceEncoding: 'data-url',
    referenceTypes: [],
    roles: [],
    limits: NO_REFERENCE_LIMITS,
    advanced: [],
  },
  'minimax-H3-super': picturesOnly(
    fixed(15),
    ['480P', '768P', '1088P', '1440P'],
    ['9:16', '16:9'],
    9
  ),
  'minimax-h3-chovy': {
    ...picturesOnly(
      fixed(15),
      ['480P', '768P', '1088P', '1440P'],
      ['9:16', '16:9'],
      9
    ),
    referenceTypes: ['image', 'audio'],
    limits: PASSTHROUGH_MINI_DEAL_LIMITS,
  },
  'wan3.0-1080p': {
    seconds: range(5, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['9:16', '16:9', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['1080p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_MINI_DEAL_LIMITS,
    advanced: [],
  },
  'Seedance 2.5 Lite': {
    seconds: fixed(15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      referenceTotal: 10,
      total: 10,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'Wan3.0 pro max': {
    seconds: range(2, 30, 30),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['adaptive', '16:9', '9:16', '4:3', '3:4', '1:1'],
    resolutions: ['480p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      video: 5,
      audio: 5,
      referenceTotal: 20,
      total: 20,
      hostedKinds: ['image', 'video', 'audio'],
    },
    advanced: [],
  },
  'kling-omni-4.0': {
    seconds: range(3, 30, 5),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 10,
      audio: 3,
      referenceTotal: 13,
      total: 13,
      hostedKinds: ['image', 'audio'],
    },
    advanced: [],
  },
  'Seedance2.0-fast-cheap': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_MINI_DEAL_LIMITS,
    advanced: [],
  },
  'Seedance2.0-dots': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.0-OvO': {
    seconds: range(5, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance 2.0 fast': {
    seconds: fixed(15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 9,
      referenceTotal: 9,
      total: 9,
      hostedKinds: ['image'],
    },
    advanced: [],
  },
  'seedance2.5 super': {
    seconds: range(5, 30, 5),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'video', 'audio'],
    roles: ['reference'],
    limits: {
      ...NO_REFERENCE_LIMITS,
      image: 30,
      video: 10,
      audio: 10,
      referenceTotal: 50,
      total: 50,
      hostedKinds: ['image', 'video', 'audio'],
    },
    advanced: [],
  },
  'seedance2.0 pro': {
    seconds: range(4, 15, 15),
    secondsField: 'seconds',
    aspectRatioField: 'ratio',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    resolutions: ['720p'],
    referenceMode: 'url-lists',
    referenceEncoding: 'data-url',
    referenceTypes: ['image', 'audio'],
    roles: ['reference'],
    limits: PASSTHROUGH_MINI_DEAL_LIMITS,
    advanced: [],
  },
}
