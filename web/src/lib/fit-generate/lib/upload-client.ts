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
import type { ReferenceAsset } from '../types'
import { dataUrlToBytes, readJson } from './relay-client'
import { relayErrorMessage } from './request-builders'
import { fitFetch as fetch } from '@/services/api/fit/transport'

export const UPLOADS_PATH = '/v1/uploads'
export const HOSTED_FILE_HOURS = 72
export const UPLOAD_CONCURRENCY = 2
export const HOSTED_REUSE_MIN_REMAINING_MS = 24 * 60 * 60 * 1000
export const HOSTED_RECHECK_AFTER_MS = 10 * 60 * 1000
export const UPLOAD_LIMIT_MESSAGE =
  'Too many reference files are stored on this account right now. Each file is kept for 72 hours; please try again later.'

const HOSTED_FILE_MS = HOSTED_FILE_HOURS * 60 * 60 * 1000
const HOSTED_CACHE_STORAGE_KEY = 'generate.hosted-uploads.v1'
const HOSTED_CACHE_MAX_ENTRIES = 500

export type HostedFile = { url: string; expiresAt: number }

type HostedEntries = Record<string, HostedFile>

let hostedEntries: HostedEntries | null = null
const inFlightUploads = new Map<string, Promise<HostedFile>>()
const confirmedAt = new Map<string, number>()
let cacheGeneration = 0

function parseExpiresAt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
    const numeric = Number(value)
    if (Number.isFinite(numeric) && numeric > 0) return parseExpiresAt(numeric)
  }
  return Date.now() + HOSTED_FILE_MS
}

function isHostedFile(value: unknown): value is HostedFile {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.url === 'string' &&
    /^https:\/\//i.test(record.url) &&
    typeof record.expiresAt === 'number' &&
    Number.isFinite(record.expiresAt)
  )
}

function pruneEntries(entries: HostedEntries, now: number): HostedEntries {
  const live = Object.entries(entries)
    .filter(([, file]) => file.expiresAt > now)
    .sort(([, a], [, b]) => b.expiresAt - a.expiresAt)
    .slice(0, HOSTED_CACHE_MAX_ENTRIES)
  return Object.fromEntries(live)
}

function readStoredEntries(): HostedEntries {
  try {
    const raw = localStorage.getItem(HOSTED_CACHE_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, HostedFile] => isHostedFile(entry[1])
      )
    )
  } catch {
    return {}
  }
}

function loadHostedEntries(): HostedEntries {
  if (!hostedEntries) {
    hostedEntries = pruneEntries(readStoredEntries(), Date.now())
  }
  return hostedEntries
}

function writeHostedEntries(
  change: (entries: HostedEntries) => HostedEntries
): void {
  const entries = pruneEntries(
    change({ ...readStoredEntries(), ...loadHostedEntries() }),
    Date.now()
  )
  hostedEntries = entries
  try {
    localStorage.setItem(HOSTED_CACHE_STORAGE_KEY, JSON.stringify(entries))
  } catch {
  }
}

function rememberHostedFile(key: string, file: HostedFile): void {
  writeHostedEntries((entries) => ({ ...entries, [key]: file }))
  confirmedAt.set(key, Date.now())
}

function forgetHostedFile(key: string): void {
  writeHostedEntries((entries) => {
    const rest = { ...entries }
    delete rest[key]
    return rest
  })
  confirmedAt.delete(key)
}

export function clearHostedUploadCache(): void {
  cacheGeneration += 1
  hostedEntries = {}
  inFlightUploads.clear()
  confirmedAt.clear()
  try {
    localStorage.removeItem(HOSTED_CACHE_STORAGE_KEY)
  } catch {
  }
}

async function sha256Hex(
  data: Uint8Array<ArrayBuffer>
): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return null
  try {
    const digest = await subtle.digest('SHA-256', data)
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')
  } catch {
    return null
  }
}

async function hostedFileKey(
  apiKey: string,
  mimeType: string,
  bytes: Uint8Array<ArrayBuffer>
): Promise<string | null> {
  const [owner, content] = await Promise.all([
    sha256Hex(new TextEncoder().encode(apiKey)),
    sha256Hex(bytes),
  ])
  if (!owner || !content) return null
  return `${owner.slice(0, 16)}:${mimeType}:${content}`
}

async function isStillHosted(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

function uploadErrorCode(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const error = (payload as Record<string, unknown>).error
  if (!error || typeof error !== 'object') return null
  const code = (error as Record<string, unknown>).code
  return typeof code === 'string' ? code : null
}

async function postReferenceFile(
  asset: ReferenceAsset,
  bytes: Uint8Array<ArrayBuffer>,
  apiKey: string
): Promise<HostedFile> {
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: asset.mimeType }), asset.name)
  const response = await fetch(UPLOADS_PATH, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  })
  const payload = await readJson(response)
  if (!response.ok) {
    if (uploadErrorCode(payload) === 'upload_limit_reached') {
      throw new Error(UPLOAD_LIMIT_MESSAGE)
    }
    throw new Error(relayErrorMessage(payload, response.status))
  }

  const record = (payload ?? {}) as Record<string, unknown>
  const url = record.url
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    throw new Error('The upload service returned no file link')
  }
  const expiresAt = Math.min(
    parseExpiresAt(record.expires_at),
    Date.now() + HOSTED_FILE_MS
  )
  return { url, expiresAt }
}

export async function uploadReferenceFile(
  asset: ReferenceAsset,
  apiKey: string
): Promise<HostedFile> {
  return postReferenceFile(asset, dataUrlToBytes(asset.dataUrl), apiKey)
}

export async function hostReferenceFile(
  asset: ReferenceAsset,
  apiKey: string
): Promise<HostedFile> {
  const bytes = dataUrlToBytes(asset.dataUrl)
  const key = await hostedFileKey(apiKey, asset.mimeType, bytes)
  if (!key) return postReferenceFile(asset, bytes, apiKey)

  const pending = inFlightUploads.get(key)
  if (pending) return pending

  const now = Date.now()
  const stored = loadHostedEntries()[key]
  const remembered =
    stored && stored.expiresAt - now >= HOSTED_REUSE_MIN_REMAINING_MS
      ? stored
      : null
  if (
    remembered &&
    now - (confirmedAt.get(key) ?? 0) < HOSTED_RECHECK_AFTER_MS
  ) {
    return remembered
  }

  const generation = cacheGeneration
  const current = () => generation === cacheGeneration
  const resolved = (async () => {
    if (remembered) {
      if (await isStillHosted(remembered.url)) {
        if (current()) confirmedAt.set(key, Date.now())
        return remembered
      }
      if (current()) forgetHostedFile(key)
    }
    const file = await postReferenceFile(asset, bytes, apiKey)
    if (current()) rememberHostedFile(key, file)
    return file
  })()
  const shared = resolved.finally(() => {
    if (inFlightUploads.get(key) === shared) inFlightUploads.delete(key)
  })
  inFlightUploads.set(key, shared)
  return shared
}

export async function uploadReferenceFiles(
  assets: ReferenceAsset[],
  apiKey: string,
  concurrency = UPLOAD_CONCURRENCY
): Promise<Map<string, HostedFile>> {
  const hosted = new Map<string, HostedFile>()
  let next = 0
  const worker = async () => {
    while (next < assets.length) {
      const asset = assets[next]
      next += 1
      hosted.set(asset.id, await hostReferenceFile(asset, apiKey))
    }
  }
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, assets.length)) },
    () => worker()
  )
  await Promise.all(workers)
  return hosted
}
