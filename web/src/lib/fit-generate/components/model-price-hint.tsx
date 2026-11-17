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
import { useTranslation } from '../shims/i18n'

import {
  getCardExamplePrice,
  getDynamicDisplayGroupRatio,
  getDynamicPriceUnitLabelKey,
  getDynamicPricingSummary,
} from '../pricing/lib/dynamic-price'
import { isTokenBasedModel } from '../pricing/lib/model-helpers'
import { formatRequestPrice } from '../pricing/lib/price'
import type { PricingModel } from '../pricing/types'
import { cn } from '../shims/utils'

import { assetKind } from '../lib/request-builders'
import type { ReferenceAsset } from '../types'

const WAN_INPUT_BILLING_HINT_KEY =
  'Reference video input seconds are also billed. Final charges use actual durations after completion.'

type ModelPriceHintProps = {
  model: PricingModel
  priceRate: number
  usdExchangeRate: number
  resolution?: string | null
  seconds?: number | null
  references?: ReferenceAsset[]
  className?: string
}

function wanBillingEstimate(props: ModelPriceHintProps) {
  const resolution = props.resolution?.toUpperCase()
  const billsVideoInput =
    props.model.model_name === 'wan3.0-video-prime' ||
    (props.model.model_name === 'wan3.0-video' &&
      (resolution === '720P' || resolution === '1080P'))
  if (!billsVideoInput) {
    return { seconds: props.seconds, includesVideoInput: false }
  }
  let includesVideoInput = false
  let inputSeconds = 0
  for (const reference of props.references ?? []) {
    if (assetKind(reference) !== 'video') continue
    includesVideoInput = true
    const duration = reference.durationSeconds
    if (duration == null || !Number.isFinite(duration) || duration <= 0) {
      return { seconds: null, includesVideoInput }
    }
    inputSeconds += duration
  }
  if (!includesVideoInput) return { seconds: props.seconds, includesVideoInput }
  if (
    props.seconds == null ||
    !Number.isFinite(props.seconds) ||
    props.seconds <= 0 ||
    !Number.isFinite(inputSeconds)
  ) {
    return { seconds: null, includesVideoInput }
  }
  return {
    seconds: props.seconds + Math.ceil(inputSeconds),
    includesVideoInput,
  }
}

function gtBillingUsage(props: ModelPriceHintProps) {
  if (props.model.model_name !== 'seedance 2.5-GT') return undefined
  const hasVideoReference = (props.references ?? []).some(
    (reference) => assetKind(reference) === 'video'
  )
  return { video_input: hasVideoReference ? 'video' : 'none' }
}

export function ModelPriceHint(props: ModelPriceHintProps) {
  const { t } = useTranslation()
  const estimate = wanBillingEstimate(props)
  const gtUsage = gtBillingUsage(props)
  const resolutionUsage = props.resolution
    ? { resolution: props.resolution }
    : undefined
  const unknownEstimate =
    estimate.includesVideoInput && estimate.seconds == null
  const inputVideoNotice = estimate.includesVideoInput ? (
    <span className='block font-sans'>{t(WAN_INPUT_BILLING_HINT_KEY)}</span>
  ) : null
  const options = {
    tokenUnit: 'M' as const,
    priceRate: props.priceRate,
    usdExchangeRate: props.usdExchangeRate,
    groupRatioMultiplier: getDynamicDisplayGroupRatio(props.model),
    taskUsage: gtUsage ? { ...resolutionUsage, ...gtUsage } : resolutionUsage,
  }
  const className = cn(
    'text-muted-foreground font-mono text-xs tabular-nums',
    props.className
  )

  const summary = getDynamicPricingSummary(props.model, options)
  if (summary?.isSpecialExpression) {
    return (
      <span className={className}>
        {t('Special billing expression')}
        {inputVideoNotice}
      </span>
    )
  }
  if (summary && summary.primaryEntries.length > 0) {
    const entry = summary.primaryEntries[0]
    const unitKey = getDynamicPriceUnitLabelKey(entry)
    let exampleModel = props.model
    let gtUnitPrice: string | undefined
    if (
      summary.primaryEntries.some(
        (item) => item.field === 'seconds' && item.unit === 'second'
      ) &&
      estimate.seconds != null
    ) {
      const selectedExamples = (
        examples: PricingModel['billing_usage_examples'],
        seconds: number
      ) => [
        {
          label: estimate.includesVideoInput
            ? t('{{seconds}}s including reference video (estimate)', {
                seconds,
              })
            : `${seconds}s`,
          facts: {
            ...examples?.[0]?.facts,
            seconds,
            ...(props.resolution ? { resolution: props.resolution } : {}),
            ...gtUsage,
          },
        },
      ]
      const modelForSeconds = (seconds: number): PricingModel => ({
        ...props.model,
        billing_usage_examples: selectedExamples(
          props.model.billing_usage_examples,
          seconds
        ),
        billing_plugin_variants: props.model.billing_plugin_variants?.map(
          (variant) => ({
            ...variant,
            billing_usage_examples: selectedExamples(
              variant.billing_usage_examples,
              seconds
            ),
          })
        ),
      })
      exampleModel = modelForSeconds(estimate.seconds)
      if (gtUsage) {
        gtUnitPrice = getCardExamplePrice(
          modelForSeconds(1),
          options
        )?.formatted
      }
    }
    const example = unknownEstimate
      ? null
      : getCardExamplePrice(exampleModel, options)
    return (
      <span className={className}>
        {gtUnitPrice ?? entry.formattedRange ?? entry.formatted} /{' '}
        {unitKey ? t(unitKey) : '1M'}
        {example && ` · ${example.label} ≈ ${example.formatted}`}
        {unknownEstimate && ` · ${t('Preview unavailable')}`}
        {inputVideoNotice}
      </span>
    )
  }

  if (estimate.includesVideoInput) {
    return (
      <span className={className}>
        {t('Preview unavailable')}
        {inputVideoNotice}
      </span>
    )
  }

  if (!isTokenBasedModel(props.model)) {
    const price = formatRequestPrice(
      props.model,
      false,
      props.priceRate,
      props.usdExchangeRate
    )
    if (price !== '-') {
      return (
        <span className={className}>
          {price} / {t('request')}
        </span>
      )
    }
  }
  return null
}
