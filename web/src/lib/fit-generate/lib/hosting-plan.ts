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
import type { ReferenceAsset, ReferenceLimits } from '../types'
import { assetKind } from './request-builders'

export type HostingLimits = Pick<
  ReferenceLimits,
  'hostedKinds' | 'maxInlineBytes'
>

export function isInlineAsset(asset: ReferenceAsset): boolean {
  return /^data:/i.test(asset.dataUrl)
}

export function inlineBytes(asset: ReferenceAsset): number {
  return isInlineAsset(asset) ? asset.dataUrl.length : 0
}

export function planHostedUploads(
  references: ReferenceAsset[],
  limits: HostingLimits
): string[] {
  const hosted = new Set<string>()
  const hostedKinds = new Set(limits.hostedKinds)
  const inline = references.filter(isInlineAsset)

  inline.forEach((asset) => {
    if (hostedKinds.has(assetKind(asset))) hosted.add(asset.id)
  })

  if (limits.maxInlineBytes != null) {
    const remaining = inline
      .filter((asset) => !hosted.has(asset.id))
      .sort((a, b) => inlineBytes(b) - inlineBytes(a))
    let total = remaining.reduce((sum, asset) => sum + inlineBytes(asset), 0)
    for (const asset of remaining) {
      if (total <= limits.maxInlineBytes) break
      hosted.add(asset.id)
      total -= inlineBytes(asset)
    }
  }

  return references
    .filter((asset) => hosted.has(asset.id))
    .map((asset) => asset.id)
}

export function hostingApplies(
  references: ReferenceAsset[],
  limits: HostingLimits
): boolean {
  return planHostedUploads(references, limits).length > 0
}
