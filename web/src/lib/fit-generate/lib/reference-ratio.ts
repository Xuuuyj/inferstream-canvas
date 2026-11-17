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
import type { ModelProfile, ReferenceAsset } from '../types'
import { assetKind } from './request-builders'

export const PADDED_MAX_EDGE = 1280
const RATIO_TOLERANCE = 0.02
const BACKGROUND_BLUR_PX = 28
const JPEG_QUALITY = 0.9

export function parseRatio(ratio: string | null | undefined): number | null {
  const match = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(
    ratio ?? ''
  )
  if (!match) return null
  const width = Number(match[1])
  const height = Number(match[2])
  return width > 0 && height > 0 ? width / height : null
}

export type PaddingPlan = {
  canvasWidth: number
  canvasHeight: number
  x: number
  y: number
  width: number
  height: number
}

export function ratioPaddingPlan(
  width: number,
  height: number,
  targetRatio: number,
  maxEdge = PADDED_MAX_EDGE
): PaddingPlan | null {
  if (!(width > 0 && height > 0 && targetRatio > 0)) return null
  if (Math.abs(width / height - targetRatio) / targetRatio <= RATIO_TOLERANCE) {
    return null
  }
  const longEdge = Math.min(maxEdge, Math.max(width, height))
  const canvasWidth =
    targetRatio >= 1 ? longEdge : Math.round(longEdge * targetRatio)
  const canvasHeight =
    targetRatio >= 1 ? Math.round(longEdge / targetRatio) : longEdge
  const scale = Math.min(canvasWidth / width, canvasHeight / height)
  const drawWidth = Math.round(width * scale)
  const drawHeight = Math.round(height * scale)
  return {
    canvasWidth,
    canvasHeight,
    x: Math.round((canvasWidth - drawWidth) / 2),
    y: Math.round((canvasHeight - drawHeight) / 2),
    width: drawWidth,
    height: drawHeight,
  }
}

const DECODE_TIMEOUT_MS = 15000

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const timer = window.setTimeout(
      () => reject(new Error('image decode timed out')),
      DECODE_TIMEOUT_MS
    )
    image.addEventListener('load', () => {
      window.clearTimeout(timer)
      resolve(image)
    })
    image.addEventListener('error', () => {
      window.clearTimeout(timer)
      reject(new Error('image could not be decoded'))
    })
    image.src = src
  })
}

export async function padImageToRatio(
  dataUrl: string,
  targetRatio: number
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (typeof document === 'undefined' || !/^data:image\//i.test(dataUrl)) {
    return null
  }
  const canvas = document.createElement('canvas')
  let context: CanvasRenderingContext2D | null = null
  try {
    context = canvas.getContext('2d')
  } catch {
    context = null
  }
  if (!context) return null
  let image: HTMLImageElement
  try {
    image = await loadImage(dataUrl)
  } catch {
    return null
  }
  const plan = ratioPaddingPlan(
    image.naturalWidth,
    image.naturalHeight,
    targetRatio
  )
  if (!plan) return null
  canvas.width = plan.canvasWidth
  canvas.height = plan.canvasHeight

  const cover = Math.max(
    plan.canvasWidth / image.naturalWidth,
    plan.canvasHeight / image.naturalHeight
  )
  const coverWidth = image.naturalWidth * cover
  const coverHeight = image.naturalHeight * cover
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, plan.canvasWidth, plan.canvasHeight)
  context.save()
  context.filter = `blur(${BACKGROUND_BLUR_PX}px)`
  context.drawImage(
    image,
    (plan.canvasWidth - coverWidth) / 2,
    (plan.canvasHeight - coverHeight) / 2,
    coverWidth,
    coverHeight
  )
  context.restore()
  context.drawImage(image, plan.x, plan.y, plan.width, plan.height)

  const padded = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  if (!padded.startsWith('data:image/jpeg;base64,')) return null
  return {
    dataUrl: padded,
    width: plan.canvasWidth,
    height: plan.canvasHeight,
  }
}

export async function padReferencesToRatio(
  profile: ModelProfile,
  aspectRatio: string | null,
  references: ReferenceAsset[]
): Promise<ReferenceAsset[]> {
  const target = parseRatio(aspectRatio)
  if (!profile.padReferencesToRatio || target == null) return references
  return Promise.all(
    references.map(async (asset) => {
      if (assetKind(asset) !== 'image') return asset
      const padded = await padImageToRatio(asset.dataUrl, target)
      if (!padded) return asset
      return {
        ...asset,
        dataUrl: padded.dataUrl,
        mimeType: 'image/jpeg',
        name: `${asset.name.replace(/\.[^.]+$/, '')}.jpg`,
      }
    })
  )
}
