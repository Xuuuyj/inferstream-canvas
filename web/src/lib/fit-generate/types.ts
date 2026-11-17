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
import type { PricingModel } from './shims/pricing-types'

export type GenerationKind = 'image' | 'video'

export type ImageApi = 'openai-image' | 'gemini-image'

export type ReferenceEncoding = 'data-url' | 'raw-base64'
export type ReferenceAssetKind = 'image' | 'video' | 'audio'

export type ReferenceRole = 'first_frame' | 'last_frame' | 'reference'

export type ReferenceMode =
  | 'none'
  | 'single-image'
  | 'image-array-b64'
  | 'image-array-url'
  | 'attachments'
  | 'h3'
  | 'content'
  | 'media'
  | 'numbered'
  | 'grok-references'
  | 'gemini-parts'
  | 'url-lists'
  | 'images-array'
  | 'h3-2k'
  | 'input-reference'

export type SecondsRule =
  | { mode: 'fixed'; value: number }
  | {
      mode: 'range'
      min: number
      max: number
      defaultValue: number
      steps?: number[]
    }

export type ReferenceLimits = {
  image: number
  minImages?: number
  video: number
  audio: number
  referenceTotal: number
  total: number
  clipSeconds: { min: number; max: number } | null
  maxClipSecondsByKind?: Partial<Record<ReferenceAssetKind, number>>
  clipSecondsRequired: ReferenceAssetKind[]
  totalClipSeconds: number | null
  totalClipSecondsByKind?: Partial<Record<ReferenceAssetKind, number>>
  combinedClipSeconds?: number
  framesMixWithReferences: boolean
  maxInlineBytes: number | null
  hostedKinds: ReferenceAssetKind[]
}

export type ResolutionRule = {
  minSeconds?: number
  maxSeconds?: number
  lastFrame?: boolean
  audioNeedsVisual?: boolean
  firstFrameOnly?: boolean
  aspectRatios?: string[]
  referenceVideo?: boolean
}

export type AdvancedParam =
  | {
      key: string
      kind: 'boolean'
      labelKey: string
      defaultValue?: boolean
    }
  | {
      key: string
      kind: 'integer'
      labelKey: string
      min: number
      max: number
    }
  | { key: string; kind: 'text'; labelKey: string; maxLength: number }
  | {
      key: string
      kind: 'choice'
      labelKey: string
      options: Array<{ value: string; labelKey: string }>
      defaultValue: string
    }

export type AdvancedValues = Record<string, boolean | number | string>

export type ModelProfile = {
  modelName: string
  kind: GenerationKind
  imageApi: ImageApi | null
  supportsImageEdit: boolean
  imageEditTransport?: 'json' | 'multipart'
  imageRequestDefaults?: Record<string, string>
  videoSize?: string
  videoSizeByAspectRatio?: Record<string, string>
  requiresFirstFrame?: boolean
  secondsAsString?: boolean
  seconds: SecondsRule | null
  resolutions: string[]
  defaultResolution?: string
  aspectRatioField: 'ratio' | 'aspect_ratio' | 'gemini' | null
  aspectRatios: string[]
  defaultAspectRatio?: string
  imageSizes: string[]
  maxReferenceImages: number
  referenceField: string | null
  referenceEncoding: ReferenceEncoding
  referenceMode: ReferenceMode
  referenceTypes: ReferenceAssetKind[]
  roles: ReferenceRole[]
  limits: ReferenceLimits
  advanced: AdvancedParam[]
  promptHintKey: string | null
  promptMinLength: number
  promptMaxLength?: number
  promptNeedsCameraMotion: boolean
  promptRulesMinSeconds: number
  padReferencesToRatio: boolean
  audioNeedsVisual: boolean
  secondsField: 'duration' | 'seconds'
  resolutionRules?: Record<string, ResolutionRule>
}

export type StudioModel = { model: PricingModel; profile: ModelProfile }

export type ReferenceImage = {
  id: string
  name: string
  mimeType: string
  dataUrl: string
  kind?: ReferenceAssetKind
  role?: ReferenceRole
  durationSeconds?: number
}

export type ReferenceAsset = ReferenceImage

export type GenerationFormValues = {
  prompt: string
  seconds: number | null
  resolution: string | null
  aspectRatio: string | null
  imageSize: string | null
  references: ReferenceImage[]
  advanced: AdvancedValues
}

export type JsonRelayRequest = {
  transport: 'json'
  path: string
  body: Record<string, unknown>
}

export type MultipartRelayRequest = {
  transport: 'multipart'
  path: string
  fields: Record<string, string>
  files: Array<{ field: string; image: ReferenceImage }>
}

export type RelayRequest = JsonRelayRequest | MultipartRelayRequest

export type GenerationTaskStatus =
  | 'uploading'
  | 'submitting'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'

export type ReferenceThumbnail = {
  name: string
  kind: ReferenceAssetKind
  role: ReferenceRole | 'reference'
  url: string
}

export type FormSnapshot = {
  seconds: number | null
  resolution: string | null
  aspectRatio: string | null
  imageSize: string | null
  advanced: AdvancedValues
}

export type GenerationTask = {
  id: string
  kind: GenerationKind
  modelName: string
  prompt: string
  summary: string[]
  keyId: number
  createdAt: number
  finishedAt: number | null
  status: GenerationTaskStatus
  progress: number
  remoteId: string | null
  imageUrls: string[]
  videoUrl: string | null
  error: string | null
  formSnapshot?: FormSnapshot | null
  referenceThumbnails?: ReferenceThumbnail[]
}
