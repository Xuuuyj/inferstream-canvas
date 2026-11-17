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
import type { RelayRequest } from '../types'
import { rawBase64, relayErrorMessage } from './request-builders'
import { fitFetch as fetch } from '@/services/api/fit/transport'

export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function dataUrlToBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const binary = atob(rawBase64(dataUrl))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function dataUrlToBlob(dataUrl: string, mimeType: string): Blob {
  return new Blob([dataUrlToBytes(dataUrl)], { type: mimeType })
}

export type RelayResult = {
  data: unknown
  requestId: string
}

export async function sendRelayRequest(
  request: RelayRequest,
  apiKey: string
): Promise<RelayResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` }
  let body: BodyInit
  if (request.transport === 'json') {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(request.body)
  } else {
    const form = new FormData()
    Object.entries(request.fields).forEach(([name, value]) =>
      form.append(name, value)
    )
    request.files.forEach((file) => {
      form.append(
        file.field,
        dataUrlToBlob(file.image.dataUrl, file.image.mimeType),
        file.image.name
      )
    })
    body = form
  }

  const response = await fetch(request.path, { method: 'POST', headers, body })
  const payload = await readJson(response)
  if (!response.ok) throw new Error(relayErrorMessage(payload, response.status))
  return {
    data: payload,
    requestId: response.headers?.get?.('X-Oneapi-Request-Id') ?? '',
  }
}

export type RemoteVideoState = {
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  progress: number
  error: string | null
}

export async function getVideoTask(
  remoteId: string,
  apiKey: string
): Promise<RemoteVideoState> {
  const response = await fetch(`/v1/videos/${encodeURIComponent(remoteId)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const payload = (await readJson(response)) as Record<string, unknown> | null
  if (!response.ok) throw new Error(relayErrorMessage(payload, response.status))

  const rawStatus = String(payload?.status ?? '').toLowerCase()
  let status: RemoteVideoState['status'] = 'in_progress'
  if (rawStatus === 'queued') status = 'queued'
  else if (rawStatus === 'completed') status = 'completed'
  else if (rawStatus === 'failed') status = 'failed'

  const errorValue = payload?.error as { message?: unknown } | undefined
  const progress = Number(payload?.progress)
  return {
    status,
    progress: Number.isFinite(progress)
      ? Math.max(0, Math.min(100, progress))
      : 0,
    error: typeof errorValue?.message === 'string' ? errorValue.message : null,
  }
}

const taskArtifactContentPathPattern =
  /\/v1\/tasks\/[^/]+\/artifacts\/[^/]+\/content$/
const taskArtifactAccessTokenPattern = /^[A-Za-z0-9_-]{43}$/

export function isTaskArtifactContentUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      taskArtifactContentPathPattern.test(url.pathname) &&
      url.searchParams.has('access')
    )
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function parseTaskArtifactContentUrl(
  value: unknown,
  expectedTaskId: string
): string | null {
  if (typeof value !== 'string' || value.trim() !== value || !value) return null
  if (!/^https?:\/\//i.test(value)) return null
  if (value.includes('#') || value.includes('\\')) return null
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x1f || codePoint === 0x7f) return null
  }

  try {
    const url = new URL(value)
    const authorityStart = value.indexOf('//') + 2
    const pathStart = value.indexOf('/', authorityStart)
    const authority = value.slice(
      authorityStart,
      pathStart === -1 ? value.length : pathStart
    )
    const access = url.searchParams.get('access')
    const pathMatch = url.pathname.match(
      /\/v1\/tasks\/([^/]+)\/artifacts\/[^/]+\/content$/
    )
    let projectedTaskId = ''
    try {
      projectedTaskId = pathMatch ? decodeURIComponent(pathMatch[1]) : ''
    } catch {
      return null
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      (window.location.protocol === 'https:' && url.protocol !== 'https:') ||
      !url.hostname ||
      authority.includes('@') ||
      url.username ||
      url.password ||
      url.hash ||
      !taskArtifactContentPathPattern.test(url.pathname) ||
      projectedTaskId !== expectedTaskId ||
      access == null ||
      !taskArtifactAccessTokenPattern.test(access) ||
      url.search !== `?access=${access}`
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export async function getVideoContentUrl(
  remoteId: string,
  apiKey: string
): Promise<string> {
  const response = await fetch(
    `/v1/tasks/${encodeURIComponent(remoteId)}/artifacts`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    }
  )
  const payload = await readJson(response)
  if (!response.ok) {
    throw new Error(relayErrorMessage(payload, response.status))
  }

  if (!isRecord(payload)) throw new Error('The service returned no video')
  if (payload.task_id !== remoteId) {
    throw new Error('The service returned no video')
  }
  if (Array.isArray(payload.artifacts)) {
    for (const value of payload.artifacts) {
      if (!isRecord(value) || value.type !== 'video') continue
      const contentUrl = parseTaskArtifactContentUrl(
        value.content_url,
        remoteId
      )
      if (contentUrl) return contentUrl
    }
  }

  const legacyContentUrl = parseTaskArtifactContentUrl(
    payload.legacy_content_url,
    remoteId
  )
  if (legacyContentUrl) return legacyContentUrl
  throw new Error('The service returned no video')
}
