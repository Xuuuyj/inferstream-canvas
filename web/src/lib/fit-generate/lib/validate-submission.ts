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
import { CAMERA_MOTION_PATTERN } from '../constants'
import type {
  GenerationFormValues,
  ModelProfile,
  ReferenceAsset,
  ReferenceAssetKind,
} from '../types'
import { secondsRuleAt } from './model-profiles'
import { statedVideoLengths } from './prompt-length'
import { DELETED_MENTION, danglingMentions } from './prompt-mentions'
import { acceptedReferences, assetKind, assetRole } from './request-builders'

export type SubmissionIssue = {
  key: string
  values?: Record<string, string | number>
}

const KIND_LABEL: Record<ReferenceAssetKind, string> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
}

function isSendableUrl(value: string): boolean {
  return /^https:\/\//i.test(value) || /^data:[^;]+;base64,/i.test(value)
}

export function promptLength(prompt: string): number {
  return prompt.length
}

function promptCodePoints(prompt: string): number {
  return [...prompt].length
}

export function allowsReferenceOnlySubmission(
  profile: ModelProfile,
  references: ReferenceAsset[]
): boolean {
  return (
    profile.modelName === 'seedance 2.5-GT' &&
    acceptedReferences(profile, references).some((reference) =>
      isSendableUrl(reference.dataUrl)
    )
  )
}

export function validateSubmission(
  profile: ModelProfile,
  values: GenerationFormValues
): SubmissionIssue[] {
  const issues: SubmissionIssue[] = []
  const prompt = values.prompt.trim()
  let targetSeconds: number | null = null
  if (profile.kind === 'video') {
    targetSeconds =
      profile.seconds?.mode === 'fixed' ? profile.seconds.value : values.seconds
  }
  const promptRulesApply =
    targetSeconds == null || targetSeconds >= profile.promptRulesMinSeconds

  if (!prompt && !allowsReferenceOnlySubmission(profile, values.references)) {
    issues.push({ key: 'Prompt is required' })
  } else if (prompt && promptRulesApply) {
    if (promptCodePoints(prompt) < profile.promptMinLength) {
      issues.push({
        key: 'The prompt needs at least {{count}} characters for this model',
        values: { count: profile.promptMinLength },
      })
    }
    if (
      profile.promptNeedsCameraMotion &&
      !CAMERA_MOTION_PATTERN.test(prompt)
    ) {
      issues.push({
        key: 'The prompt must describe a camera movement (push in, pull back, orbit, follow, pan, zoom)',
      })
    }
  }

  if (prompt && targetSeconds != null) {
    const stated = statedVideoLengths(prompt).find(
      (value) => value !== targetSeconds
    )
    if (stated != null) {
      issues.push({
        key: 'The prompt asks for a {{stated}}-second video but the length setting is {{actual}} s; make them match',
        values: { stated, actual: targetSeconds },
      })
    }
  }

  const secondsRule = secondsRuleAt(profile, values.resolution)
  if (secondsRule?.mode === 'range') {
    const seconds = values.seconds
    if (
      seconds == null ||
      !Number.isInteger(seconds) ||
      seconds < secondsRule.min ||
      seconds > secondsRule.max
    ) {
      issues.push({
        key: 'Video length must be a whole number from {{min}} to {{max}} seconds',
        values: { min: secondsRule.min, max: secondsRule.max },
      })
    } else if (secondsRule.steps && !secondsRule.steps.includes(seconds)) {
      issues.push({
        key: 'Video length must be one of {{values}} seconds',
        values: { values: secondsRule.steps.join(', ') },
      })
    }
  }

  profile.advanced.forEach((param) => {
    const value = values.advanced[param.key]
    if (
      param.kind === 'choice' &&
      value != null &&
      !param.options.some((option) => option.value === value)
    ) {
      issues.push({
        key: '{{field}} must be one of: {{options}}',
        values: {
          field: param.labelKey,
          options: param.options.map((option) => option.value).join(', '),
        },
      })
    }
    if (param.kind === 'integer' && typeof value === 'number') {
      if (!Number.isInteger(value) || value < param.min || value > param.max) {
        issues.push({
          key: '{{field}} must be a whole number from {{min}} to {{max}}',
          values: { field: param.labelKey, min: param.min, max: param.max },
        })
      }
    }
  })

  const references = values.references
  const dangling = danglingMentions(values.prompt, references)
  if (dangling.includes(DELETED_MENTION)) {
    issues.push({
      key: 'The prompt still mentions a removed reference ({{token}}). Delete it or upload the media again.',
      values: { token: DELETED_MENTION },
    })
  }
  const missing = dangling.filter((token) => token !== DELETED_MENTION)
  if (missing.length > 0) {
    issues.push({
      key: 'The prompt mentions {{tokens}}, but there is no such reference media',
      values: { tokens: missing.join(', ') },
    })
  }
  const limits = profile.limits
  const counts: Record<ReferenceAssetKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
  }
  const clipTotals: Record<ReferenceAssetKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
  }
  let firstFrames = 0
  let lastFrames = 0
  let plain = 0
  let accepted = 0

  references.forEach((asset) => {
    const kind = assetKind(asset)
    const role = assetRole(asset)
    if (!profile.referenceTypes.includes(kind)) {
      issues.push({
        key: 'This model does not accept {{kind}} references',
        values: { kind: KIND_LABEL[kind] },
      })
      return
    }
    if (!profile.roles.includes(role)) {
      issues.push({ key: 'This model has no {{role}} slot', values: { role } })
      return
    }
    accepted += 1
    if (!isSendableUrl(asset.dataUrl)) {
      issues.push({
        key: '{{name}} must be an uploaded file or an https URL',
        values: { name: asset.name },
      })
    }
    if (role !== 'reference') {
      if (kind !== 'image') {
        issues.push({ key: 'First and last frames must be images' })
      }
      if (role === 'first_frame') firstFrames += 1
      else lastFrames += 1
      return
    }
    plain += 1
    counts[kind] += 1
    if (kind === 'image') return
    const seconds = asset.durationSeconds
    const known =
      typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    const maxClipSeconds = limits.maxClipSecondsByKind?.[kind]
    if (known && maxClipSeconds != null && seconds > maxClipSeconds) {
      issues.push({
        key: '{{name}} is {{seconds}} s; {{kind}} references must not exceed {{max}} s',
        values: {
          name: asset.name,
          seconds: Number(seconds.toFixed(2)),
          kind: KIND_LABEL[kind],
          max: maxClipSeconds,
        },
      })
    }
    if (limits.clipSecondsRequired.includes(kind) && !known) {
      issues.push({
        key: 'The length of {{name}} could not be read; {{kind}} references need a known length of {{min}}-{{max}} s',
        values: {
          name: asset.name,
          kind: KIND_LABEL[kind],
          min: limits.clipSeconds?.min ?? 1,
          max: limits.clipSeconds?.max ?? 15,
        },
      })
      return
    }
    if (known && limits.clipSeconds) {
      const rounded =
        profile.modelName === 'seedance 2.5-GT' ? seconds : Math.round(seconds)
      const inRange =
        rounded >= limits.clipSeconds.min && rounded <= limits.clipSeconds.max
      if (!inRange) {
        issues.push({
          key: '{{name}} is {{seconds}} s; {{kind}} references must be {{min}}-{{max}} s',
          values: {
            name: asset.name,
            seconds: rounded,
            kind: KIND_LABEL[kind],
            min: limits.clipSeconds.min,
            max: limits.clipSeconds.max,
          },
        })
      }
      if (inRange) clipTotals[kind] += rounded
    }
  })

  if (limits.minImages != null && counts.image < limits.minImages) {
    issues.push({
      key: 'This model requires {{min}} or more reference images',
      values: { min: limits.minImages },
    })
  }
  if (firstFrames > 1) issues.push({ key: 'Only one first frame is allowed' })
  if (profile.requiresFirstFrame && firstFrames === 0) {
    issues.push({ key: 'This model requires a first frame image' })
  }
  if (lastFrames > 1) issues.push({ key: 'Only one last frame is allowed' })
  const atResolution = values.resolution
    ? profile.resolutionRules?.[values.resolution]
    : undefined
  if (lastFrames > 0 && atResolution?.lastFrame === false) {
    issues.push({
      key: 'A last frame is not available at {{resolution}} on this model',
      values: { resolution: values.resolution ?? '' },
    })
  }
  if (atResolution?.referenceVideo === false && counts.video > 0) {
    issues.push({
      key: 'Reference videos are not available at {{resolution}} on this model',
      values: { resolution: values.resolution ?? '' },
    })
  }
  if (
    values.aspectRatio &&
    atResolution?.aspectRatios &&
    !atResolution.aspectRatios.includes(values.aspectRatio)
  ) {
    issues.push({
      key: 'Aspect ratio {{ratio}} is not available at {{resolution}} on this model',
      values: {
        ratio: values.aspectRatio,
        resolution: values.resolution ?? '',
      },
    })
  }
  if (atResolution?.firstFrameOnly && (plain > 0 || lastFrames > 0)) {
    issues.push({
      key: 'Only a single first frame is available at {{resolution}} on this model',
      values: { resolution: values.resolution ?? '' },
    })
  }
  if (
    (firstFrames > 0 || lastFrames > 0) &&
    plain > 0 &&
    !limits.framesMixWithReferences
  ) {
    issues.push({
      key: 'First/last frames cannot be combined with reference media on this model',
    })
  }
  if (profile.referenceMode === 'h3' && counts.image > 0) {
    if (lastFrames > 0) {
      issues.push({
        key: 'A last frame cannot be combined with reference images on this model',
      })
    }
    if (
      firstFrames > 0 &&
      limits.image > 0 &&
      counts.image + 1 > limits.image
    ) {
      issues.push({
        key: 'The first frame counts toward the {{max}} reference images this model allows',
        values: { max: limits.image },
      })
    }
  }
  if (profile.referenceMode === 'h3-2k' && limits.image > 0) {
    const pictures = counts.image + firstFrames + lastFrames
    if (counts.image > 0 && pictures > limits.image) {
      issues.push({
        key: 'Pictures and first/last frames together are limited to {{max}} on this model',
        values: { max: limits.image },
      })
    }
  }
  const hasVisual = counts.image + counts.video + firstFrames + lastFrames > 0
  if (profile.audioNeedsVisual && counts.audio > 0 && !hasVisual) {
    issues.push({
      key: 'Audio references need at least one picture or video on this model',
    })
  } else if (
    atResolution?.audioNeedsVisual &&
    counts.audio > 0 &&
    counts.image === 0
  ) {
    issues.push({
      key: 'Audio references need at least one picture at {{resolution}} on this model',
      values: { resolution: values.resolution ?? '' },
    })
  }
  ;(['image', 'video', 'audio'] as ReferenceAssetKind[]).forEach((kind) => {
    if (counts[kind] > 0 && limits[kind] === 0) {
      issues.push({
        key: 'This model takes {{kind}} only as a first or last frame, not as a plain reference',
        values: { kind: KIND_LABEL[kind] },
      })
    } else if (counts[kind] > limits[kind]) {
      issues.push({
        key: 'At most {{max}} {{kind}} references are allowed',
        values: { max: limits[kind], kind: KIND_LABEL[kind] },
      })
    }
    const totalMax =
      limits.totalClipSecondsByKind?.[kind] ?? limits.totalClipSeconds
    if (totalMax != null && kind !== 'image' && clipTotals[kind] > totalMax) {
      issues.push({
        key: '{{kind}} references add up to {{seconds}} s; the limit is {{max}} s in total',
        values: {
          kind: KIND_LABEL[kind],
          seconds: clipTotals[kind],
          max: totalMax,
        },
      })
    }
  })
  const combined = clipTotals.video + clipTotals.audio
  if (
    limits.combinedClipSeconds != null &&
    clipTotals.video > 0 &&
    clipTotals.audio > 0 &&
    combined > limits.combinedClipSeconds
  ) {
    issues.push({
      key: 'Video and audio references add up to {{seconds}} s; the limit is {{max}} s together',
      values: { seconds: combined, max: limits.combinedClipSeconds },
    })
  }
  if (plain > limits.referenceTotal) {
    issues.push({
      key: 'At most {{max}} reference items are allowed in total',
      values: { max: limits.referenceTotal },
    })
  }
  if (accepted > limits.total) {
    issues.push({
      key: 'At most {{max}} media items are allowed in total',
      values: { max: limits.total },
    })
  }

  return issues
}
