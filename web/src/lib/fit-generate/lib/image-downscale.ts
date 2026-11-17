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

export const REFERENCE_IMAGE_MAX_EDGE = 1280
export const REFERENCE_IMAGE_MAX_BYTES = 2 * 1024 * 1024
const JPEG_QUALITY = 0.9
const DECODE_TIMEOUT_MS = 15000

export type DownscaledImage = {
  dataUrl: string
  mimeType: string
  name: string
  bytes: number
  width: number
  height: number
}

export function fitWithin(
  width: number,
  height: number,
  maxEdge = REFERENCE_IMAGE_MAX_EDGE
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

export function needsDownscale(
  width: number,
  height: number,
  bytes: number
): boolean {
  return (
    Math.max(width, height) > REFERENCE_IMAGE_MAX_EDGE ||
    bytes > REFERENCE_IMAGE_MAX_BYTES
  )
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
  }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
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
      image.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
}

export async function downscaleImage(
  file: File
): Promise<DownscaledImage | null> {
  if (
    typeof document === 'undefined' ||
    typeof createImageBitmap !== 'function'
  ) {
    return null
  }
  let source: ImageBitmap | HTMLImageElement
  try {
    source = await decode(file)
  } catch {
    return null
  }
  const width = 'naturalWidth' in source ? source.naturalWidth : source.width
  const height =
    'naturalHeight' in source ? source.naturalHeight : source.height
  const release = () => {
    if ('close' in source) source.close()
  }
  if (!width || !height || !needsDownscale(width, height, file.size)) {
    release()
    return null
  }
  const target = fitWithin(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = target.width
  canvas.height = target.height
  const context = canvas.getContext('2d')
  if (!context) {
    release()
    return null
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, target.width, target.height)
  context.drawImage(source, 0, 0, target.width, target.height)
  release()
  const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  if (!dataUrl.startsWith('data:image/jpeg;base64,')) return null
  const payload = dataUrl.length - 'data:image/jpeg;base64,'.length
  return {
    dataUrl,
    mimeType: 'image/jpeg',
    name: `${file.name.replace(/\.[^.]+$/, '')}.jpg`,
    bytes: Math.floor((payload * 3) / 4),
    width: target.width,
    height: target.height,
  }
}
