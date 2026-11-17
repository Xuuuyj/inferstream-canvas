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
  AdvancedValues,
  GenerationFormValues,
  ModelProfile,
  ReferenceAsset,
  ReferenceAssetKind,
  ReferenceEncoding,
  ReferenceRole,
  RelayRequest,
} from '../types'

export function rawBase64(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl
}

export function assetKind(asset: ReferenceAsset): ReferenceAssetKind {
  if (asset.kind) return asset.kind
  if (asset.mimeType.startsWith('video/')) return 'video'
  if (asset.mimeType.startsWith('audio/')) return 'audio'
  return 'image'
}

export function assetRole(asset: ReferenceAsset): ReferenceRole {
  return asset.role ?? 'reference'
}

function isHttpsUrl(value: string): boolean {
  return /^https:\/\//i.test(value)
}

function encodeReference(asset: ReferenceAsset, encoding: ReferenceEncoding) {
  if (encoding === 'raw-base64' && !isHttpsUrl(asset.dataUrl)) {
    return rawBase64(asset.dataUrl)
  }
  return asset.dataUrl
}

export function acceptedReferences(
  profile: ModelProfile,
  references: ReferenceAsset[]
): ReferenceAsset[] {
  const kinds = new Set(profile.referenceTypes)
  const roles = new Set(profile.roles)
  return references
    .filter(
      (asset) => kinds.has(assetKind(asset)) && roles.has(assetRole(asset))
    )
    .slice(0, profile.limits.total)
}

function clipDuration(asset: ReferenceAsset): Record<string, number> {
  const seconds = asset.durationSeconds
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? { duration_seconds: Math.round(seconds) }
    : {}
}

function contentPart(asset: ReferenceAsset) {
  const kind = assetKind(asset)
  const role =
    assetRole(asset) === 'first_frame' ? 'first_frame' : `reference_${kind}`
  return { type: `${kind}_url`, [`${kind}_url`]: { url: asset.dataUrl }, role }
}

const CODEX_IMAGE_MODEL = 'gpt-image-2-codex'
const CATALOG_QUALITY_IMAGE_MODELS = new Set([
  CODEX_IMAGE_MODEL,
  'gpt-image-2-stable',
  'gpt-image-2.5-flare-stable',
  'gpt-image-2.5-sunburst-stable',
])

export function advancedFields(
  params: AdvancedParam[],
  values: AdvancedValues
): Record<string, boolean | number | string> {
  const out: Record<string, boolean | number | string> = {}
  params.forEach((param) => {
    const value = values[param.key]
    if (param.kind === 'boolean') {
      if (param.defaultValue != null) {
        out[param.key] = typeof value === 'boolean' ? value : param.defaultValue
      } else if (param.key === 'ai_enhance' && typeof value === 'boolean') {
        out[param.key] = value
      } else if (value === true) out[param.key] = true
    }
    if (
      param.kind === 'integer' &&
      typeof value === 'number' &&
      Number.isFinite(value)
    ) {
      out[param.key] = Math.trunc(value)
    }
    if (param.kind === 'text' && typeof value === 'string' && value.trim()) {
      out[param.key] = value.trim().slice(0, param.maxLength)
    }
    if (param.kind === 'choice') {
      const selected = value ?? param.defaultValue
      if (param.options.some((option) => option.value === selected)) {
        out[param.key] = selected
      }
    }
  })
  return out
}

function videoReferenceFields(
  profile: ModelProfile,
  prompt: string,
  references: ReferenceAsset[]
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  const firstFrame = references.find((a) => assetRole(a) === 'first_frame')
  const lastFrame = references.find((a) => assetRole(a) === 'last_frame')
  const plain = references.filter((a) => assetRole(a) === 'reference')
  if (references.length === 0) return body

  switch (profile.referenceMode) {
    case 'attachments': {
      if (firstFrame) body.image_url = firstFrame.dataUrl
      if (lastFrame) body.last_frame_image_url = lastFrame.dataUrl
      if (plain.length > 0) {
        body.attachments = plain.map((asset) => ({
          type: assetKind(asset),
          url: asset.dataUrl,
          ...(assetKind(asset) === 'image' ? {} : clipDuration(asset)),
        }))
      }
      return body
    }
    case 'h3': {
      const pictures = plain.filter((asset) => assetKind(asset) === 'image')
      const clips = plain.filter((asset) => assetKind(asset) !== 'image')
      if (firstFrame && pictures.length === 0) {
        body.image_url = firstFrame.dataUrl
      }
      if (lastFrame) body.last_frame_image_url = lastFrame.dataUrl
      if (firstFrame && lastFrame) body.reference_type = 'first_frame'
      const list =
        firstFrame && pictures.length > 0 ? [firstFrame, ...pictures] : pictures
      if (list.length > 0) {
        if (list.every((asset) => isHttpsUrl(asset.dataUrl))) {
          body.image_urls = list.map((asset) => asset.dataUrl)
        } else {
          body.image_b64s = list.map((asset) => asset.dataUrl)
        }
      }
      if (clips.length > 0) {
        body.attachments = clips.map((asset) => ({
          type: assetKind(asset),
          url: asset.dataUrl,
          ...clipDuration(asset),
        }))
      }
      return body
    }
    case 'content': {
      body.content = [
        { type: 'text', text: prompt },
        ...references.map(contentPart),
      ]
      return body
    }
    case 'image-array-url': {
      body.image_urls = references.map((asset) => asset.dataUrl)
      return body
    }
    case 'image-array-b64': {
      if (references.every((asset) => isHttpsUrl(asset.dataUrl))) {
        body.image_urls = references.map((asset) => asset.dataUrl)
      } else {
        body.image_b64s = references.map((asset) =>
          encodeReference(asset, 'raw-base64')
        )
      }
      return body
    }
    case 'media': {
      body.media = references.map((asset) => {
        const kind = assetKind(asset)
        const role = assetRole(asset)
        const type = role === 'reference' ? `reference_${kind}` : role
        return {
          type,
          url: asset.dataUrl,
          ...(kind === 'image' ? {} : clipDuration(asset)),
        }
      })
      return body
    }
    case 'numbered': {
      let imageIndex = 0
      let audioIndex = 0
      references.forEach((asset) => {
        const kind = assetKind(asset)
        if (kind === 'image') {
          body[`ref_image_${imageIndex}`] = encodeReference(asset, 'raw-base64')
          imageIndex += 1
        } else if (kind === 'audio') {
          body[`ref_audio_${audioIndex}`] = encodeReference(asset, 'raw-base64')
          audioIndex += 1
        }
      })
      return body
    }
    case 'grok-references': {
      if (plain.length > 0) {
        body.reference_images = (
          firstFrame ? [firstFrame, ...plain] : plain
        ).map((asset) => ({ url: asset.dataUrl }))
      } else if (firstFrame) {
        body.image_url = firstFrame.dataUrl
      }
      return body
    }
    case 'url-lists': {
      const lists: Array<[string, ReferenceAssetKind]> = [
        ['image_urls', 'image'],
        ['video_urls', 'video'],
        ['audio_urls', 'audio'],
      ]
      lists.forEach(([field, kind]) => {
        const items = plain.filter((asset) => assetKind(asset) === kind)
        if (items.length > 0) body[field] = items.map((asset) => asset.dataUrl)
      })
      return body
    }
    case 'images-array': {
      if (plain.length > 0) body.images = plain.map((asset) => asset.dataUrl)
      return body
    }
    case 'h3-2k': {
      if (firstFrame) body.start_image_url = firstFrame.dataUrl
      if (lastFrame) body.end_image_url = lastFrame.dataUrl
      const pictures = plain.filter((asset) => assetKind(asset) === 'image')
      const audio = plain.filter((asset) => assetKind(asset) === 'audio')
      if (pictures.length > 0) {
        body.image_urls = pictures.map((asset) => asset.dataUrl)
      }
      if (audio.length > 0) {
        body.audio_reference = audio.map((asset) => asset.dataUrl)
      }
      return body
    }
    case 'single-image': {
      if (profile.referenceField) {
        body[profile.referenceField] = encodeReference(
          references[0],
          profile.referenceEncoding
        )
      }
      return body
    }
    case 'input-reference': {
      const frames = [firstFrame, lastFrame].filter((asset) => asset != null)
      if (frames.length === 1) body.input_reference = frames[0].dataUrl
      if (frames.length > 1) {
        body.input_reference = frames.map((asset) => asset.dataUrl)
      }
      return body
    }
    default:
      return body
  }
}

export function buildRelayRequest(
  profile: ModelProfile,
  values: GenerationFormValues
): RelayRequest {
  const prompt = values.prompt.trim()
  const references = acceptedReferences(profile, values.references)

  if (profile.kind === 'video') {
    const body: Record<string, unknown> = { model: profile.modelName, prompt }
    if (profile.videoSize) body.size = profile.videoSize
    else if (profile.videoSizeByAspectRatio) {
      const ratio =
        values.aspectRatio &&
        Object.hasOwn(profile.videoSizeByAspectRatio, values.aspectRatio)
          ? values.aspectRatio
          : profile.aspectRatios[0]
      body.size = profile.videoSizeByAspectRatio[ratio]
    }
    if (profile.seconds?.mode === 'fixed') {
      body[profile.secondsField] = profile.secondsAsString
        ? String(profile.seconds.value)
        : profile.seconds.value
    } else if (profile.seconds?.mode === 'range' && values.seconds != null) {
      body[profile.secondsField] = profile.secondsAsString
        ? String(values.seconds)
        : values.seconds
    }
    if (profile.modelName === 'seedance-2.5-omni') {
      body.resolution = profile.resolutions.includes(values.resolution ?? '')
        ? values.resolution
        : profile.resolutions[0]
    } else if (
      !profile.videoSize &&
      !profile.videoSizeByAspectRatio &&
      values.resolution &&
      profile.resolutions.includes(values.resolution)
    ) {
      body.resolution = values.resolution
    }
    const ratioField = profile.aspectRatioField
    if (
      (ratioField === 'ratio' || ratioField === 'aspect_ratio') &&
      values.aspectRatio &&
      profile.aspectRatios.includes(values.aspectRatio)
    ) {
      body[ratioField] = values.aspectRatio
    }
    Object.assign(body, videoReferenceFields(profile, prompt, references))
    Object.assign(body, advancedFields(profile.advanced, values.advanced))
    if (profile.modelName === 'seedance2.5 Ultra') {
      body.face_split = values.advanced.face_split === true
    }
    return { transport: 'json', path: '/v1/videos', body }
  }

  if (profile.imageApi === 'gemini-image') {
    const parts: Array<Record<string, unknown>> = [{ text: prompt }]
    references.forEach((image) => {
      parts.push({
        inline_data: {
          mime_type: image.mimeType,
          data: rawBase64(image.dataUrl),
        },
      })
    })
    const imageConfig: Record<string, string> = {}
    if (
      values.aspectRatio &&
      profile.aspectRatios.includes(values.aspectRatio)
    ) {
      imageConfig.aspectRatio = values.aspectRatio
    }
    if (values.imageSize && profile.imageSizes.includes(values.imageSize)) {
      imageConfig.imageSize =
        values.imageSize === '0.5K' ? '512' : values.imageSize
    }
    return {
      transport: 'json',
      path: `/v1beta/models/${encodeURIComponent(profile.modelName)}:generateContent`,
      body: {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          candidateCount: 1,
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig,
        },
      },
    }
  }

  const size =
    values.imageSize && profile.imageSizes.includes(values.imageSize)
      ? values.imageSize
      : null
  const quality = CATALOG_QUALITY_IMAGE_MODELS.has(profile.modelName)
    ? advancedFields(profile.advanced, values.advanced)
    : {}

  if (profile.supportsImageEdit && references.length > 0) {
    if (profile.imageEditTransport === 'json') {
      return {
        transport: 'json',
        path: '/v1/images/edits',
        body: {
          ...profile.imageRequestDefaults,
          model: profile.modelName,
          prompt,
          n: 1,
          ...(size ? { size } : {}),
          ...quality,
          images: references.map((image) => ({ image_url: image.dataUrl })),
        },
      }
    }
    const fields: Record<string, string> = {
      model: profile.modelName,
      prompt,
      n: '1',
    }
    if (size) fields.size = size
    Object.entries(quality).forEach(([key, value]) => {
      fields[key] = String(value)
    })
    return {
      transport: 'multipart',
      path: '/v1/images/edits',
      fields,
      files: references.map((image) => ({ field: 'image', image })),
    }
  }

  const body: Record<string, unknown> = {
    ...profile.imageRequestDefaults,
    model: profile.modelName,
    prompt,
    n: 1,
    ...quality,
  }
  if (size) body.size = size
  return { transport: 'json', path: '/v1/images/generations', body }
}

export function summarizeValues(
  profile: ModelProfile,
  values: GenerationFormValues
): string[] {
  const chips: string[] = []
  if (profile.seconds?.mode === 'fixed') chips.push(`${profile.seconds.value}s`)
  if (profile.seconds?.mode === 'range' && values.seconds != null) {
    chips.push(`${values.seconds}s`)
  }
  if (values.resolution && profile.resolutions.includes(values.resolution)) {
    chips.push(values.resolution)
  }
  if (values.aspectRatio && profile.aspectRatios.includes(values.aspectRatio)) {
    chips.push(values.aspectRatio)
  }
  if (values.imageSize && profile.imageSizes.includes(values.imageSize)) {
    chips.push(values.imageSize)
  }
  const references = acceptedReferences(profile, values.references)
  const frames = references.filter((a) => assetRole(a) !== 'reference').length
  const plain = references.length - frames
  if (frames > 0) chips.push(`frame×${frames}`)
  if (plain > 0) chips.push(`ref×${plain}`)
  Object.keys(advancedFields(profile.advanced, values.advanced)).forEach(
    (key) => chips.push(key)
  )
  return chips
}

type ImageResponseItem = { url?: unknown; b64_json?: unknown }
type GeminiPart = {
  text?: unknown
  inlineData?: { mimeType?: unknown; data?: unknown }
  inline_data?: { mime_type?: unknown; data?: unknown }
}

export function extractImageResults(payload: unknown): {
  images: string[]
  text: string
} {
  const images: string[] = []
  const texts: string[] = []
  if (!payload || typeof payload !== 'object') return { images, text: '' }
  const record = payload as Record<string, unknown>

  if (Array.isArray(record.data)) {
    ;(record.data as ImageResponseItem[]).forEach((item) => {
      if (typeof item?.url === 'string' && item.url) images.push(item.url)
      else if (typeof item?.b64_json === 'string' && item.b64_json) {
        images.push(`data:image/png;base64,${item.b64_json}`)
      }
    })
  }

  if (Array.isArray(record.candidates)) {
    record.candidates.forEach((candidate) => {
      const parts = (candidate as { content?: { parts?: GeminiPart[] } })
        ?.content?.parts
      if (!Array.isArray(parts)) return
      parts.forEach((part) => {
        const inline = part.inlineData ?? part.inline_data
        const data = inline?.data
        if (typeof data === 'string' && data) {
          const mime =
            (part.inlineData?.mimeType as string | undefined) ??
            (part.inline_data?.mime_type as string | undefined) ??
            'image/png'
          images.push(`data:${mime};base64,${data}`)
        } else if (typeof part.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim())
        }
      })
    })
  }

  return { images, text: texts.join('\n') }
}

export function relayErrorMessage(payload: unknown, status: number): string {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const error = record.error
    if (error && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message
      if (typeof message === 'string' && message) return message
    }
    if (typeof error === 'string' && error) return error
    if (typeof record.message === 'string' && record.message) {
      return record.message
    }
  }
  return `HTTP ${status}`
}
