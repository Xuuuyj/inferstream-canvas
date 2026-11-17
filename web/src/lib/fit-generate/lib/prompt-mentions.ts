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
  ReferenceAssetKind,
  ReferenceImage,
  ReferenceRole,
} from '../types'
import { assetKind, assetRole } from './request-builders'

export type MentionOption = {
  id: string
  token: string
  kind: ReferenceAssetKind
  role: ReferenceRole
  asset: ReferenceImage
}

export const DELETED_MENTION = '@已删除素材'

const KIND_TOKEN: Record<ReferenceAssetKind, string> = {
  image: '图',
  video: '视频',
  audio: '音频',
}
const ROLE_TOKEN: Record<Exclude<ReferenceRole, 'reference'>, string> = {
  first_frame: '首帧',
  last_frame: '尾帧',
}

const MENTION_PATTERN = /@(?:图\d+|视频\d+|音频\d+|首帧|尾帧|已删除素材)/g

export function mentionOptions(references: ReferenceImage[]): MentionOption[] {
  const counters: Record<ReferenceAssetKind, number> = {
    image: 0,
    video: 0,
    audio: 0,
  }
  return references.map((asset) => {
    const kind = assetKind(asset)
    const role = assetRole(asset)
    let label: string
    if (role === 'reference') {
      counters[kind] += 1
      label = `${KIND_TOKEN[kind]}${counters[kind]}`
    } else {
      label = ROLE_TOKEN[role]
    }
    return { id: asset.id, token: `@${label}`, kind, role, asset }
  })
}

export function remapMentions(
  prompt: string,
  before: ReferenceImage[],
  after: ReferenceImage[]
): string {
  const oldTokens = new Map(
    mentionOptions(before).map((option) => [option.token, option.id])
  )
  const newTokens = new Map(
    mentionOptions(after).map((option) => [option.id, option.token])
  )
  return prompt.replace(MENTION_PATTERN, (match) => {
    const id = oldTokens.get(match)
    if (id == null) return match
    return newTokens.get(id) ?? DELETED_MENTION
  })
}

export function danglingMentions(
  prompt: string,
  references: ReferenceImage[]
): string[] {
  const known = new Set(mentionOptions(references).map((o) => o.token))
  const out: string[] = []
  for (const match of prompt.matchAll(MENTION_PATTERN)) {
    if (!known.has(match[0]) && !out.includes(match[0])) out.push(match[0])
  }
  return out
}

export function usedMentions(
  prompt: string,
  references: ReferenceImage[]
): MentionOption[] {
  const options = mentionOptions(references)
  const out: MentionOption[] = []
  for (const match of prompt.matchAll(MENTION_PATTERN)) {
    const hit = options.find((option) => option.token === match[0])
    if (hit && !out.includes(hit)) out.push(hit)
  }
  return out
}

export type MentionQuery = { start: number; query: string }

export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret)
  const match = /[@＠]([^\s@＠]{0,8})$/.exec(before)
  if (!match) return null
  return { start: caret - match[0].length, query: match[1] }
}

export function filterMentionOptions(
  options: MentionOption[],
  query: string
): MentionOption[] {
  const q = query.trim()
  if (!q) return options
  return options.filter((option) => option.token.slice(1).includes(q))
}

export function insertMention(
  text: string,
  start: number,
  end: number,
  token: string
): { text: string; caret: number } {
  const after = text.slice(end)
  const spacer = after.startsWith(' ') ? '' : ' '
  const next = `${text.slice(0, start)}${token}${spacer}${after}`
  return { text: next, caret: start + token.length + 1 }
}
