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

const SEGMENT_RANGE =
  /\d+\s*[-‑–—~～至到]\s*\d+\s*(?:秒钟|秒|seconds?|secs?|s)(?![a-z])/gi
const RHYTHM_NOTE = /每\s*\d+\s*(?:秒钟|秒)/g

const UNIT = String.raw`(?:秒钟|秒|seconds?|secs?|s)(?![a-z])`
const NUMBER = String.raw`(?<![\d.])(\d{1,3})`
const STATED_LENGTH = [
  new RegExp(
    String.raw`${NUMBER}\s*[-‑–]?\s*${UNIT}(?:\s*(?:的|钟的|long))?[^\d，,。.：:；;、\n]{0,8}?(?:视频|短视频|短片|广告片|广告|影片|片子|video|clip|film|commercial)`,
    'gi'
  ),
  new RegExp(
    String.raw`(?:时长|总时长|总长|全长|长度|duration|length|runtime)\s*(?:为|是|of|:|：|=)?\s*${NUMBER}\s*[-‑–]?\s*${UNIT}`,
    'gi'
  ),
  new RegExp(String.raw`${NUMBER}\s*[-‑–]?\s*${UNIT}\s*(?:long|长)`, 'gi'),
]

export function statedVideoLengths(prompt: string): number[] {
  const text = prompt.replace(SEGMENT_RANGE, ' ').replace(RHYTHM_NOTE, ' ')
  const found: number[] = []
  STATED_LENGTH.forEach((pattern) => {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1])
      if (Number.isInteger(value) && value > 0 && !found.includes(value)) {
        found.push(value)
      }
    }
  })
  return found
}
