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
import {
  useSystemConfigStore,
  DEFAULT_CURRENCY_CONFIG,
  type CurrencyConfig,
  type CurrencyDisplayType,
} from '../shims/system-config-store'

export interface CurrencyFormatOptions {
  digitsLarge?: number
  digitsSmall?: number
  abbreviate?: boolean
  minimumNonZero?: number
  compact?: boolean
  showSymbol?: boolean
  locale?: Intl.LocalesArgument | undefined
}

type ResolvedCurrencyFormatOptions = Omit<
  Required<CurrencyFormatOptions>,
  'locale'
> & {
  locale: Intl.LocalesArgument | undefined
}

type DisplayMeta =
  | {
      kind: 'currency'
      symbol: string
      currencyCode: string
      exchangeRate: number
    }
  | {
      kind: 'custom'
      symbol: string
      exchangeRate: number
    }
  | {
      kind: 'tokens'
      quotaPerUnit: number
    }

const DEFAULT_FORMAT_OPTIONS: ResolvedCurrencyFormatOptions = {
  digitsLarge: 2,
  digitsSmall: 4,
  abbreviate: true,
  minimumNonZero: 0,
  compact: false,
  showSymbol: true,
  locale: undefined,
}

const DISPLAY_TYPE_VALUES = ['USD', 'CNY', 'TOKENS', 'CUSTOM'] as const
type DisplayTypeLiteral = (typeof DISPLAY_TYPE_VALUES)[number]

export function isCurrencyDisplayType(
  value: unknown
): value is CurrencyDisplayType {
  return (
    typeof value === 'string' &&
    DISPLAY_TYPE_VALUES.includes(value as DisplayTypeLiteral)
  )
}

export function parseCurrencyDisplayType(
  value: unknown,
  fallback: CurrencyDisplayType = 'USD'
): CurrencyDisplayType {
  return isCurrencyDisplayType(value) ? value : fallback
}

function getConfig(): CurrencyConfig {
  const { config } = useSystemConfigStore.getState()
  const currency = config?.currency ?? DEFAULT_CURRENCY_CONFIG
  return {
    ...DEFAULT_CURRENCY_CONFIG,
    ...currency,
    quotaPerUnit:
      currency?.quotaPerUnit && currency.quotaPerUnit > 0
        ? currency.quotaPerUnit
        : DEFAULT_CURRENCY_CONFIG.quotaPerUnit,
    usdExchangeRate:
      currency?.usdExchangeRate && currency.usdExchangeRate > 0
        ? currency.usdExchangeRate
        : DEFAULT_CURRENCY_CONFIG.usdExchangeRate,
    customCurrencyExchangeRate:
      currency?.customCurrencyExchangeRate &&
      currency.customCurrencyExchangeRate > 0
        ? currency.customCurrencyExchangeRate
        : DEFAULT_CURRENCY_CONFIG.customCurrencyExchangeRate,
    customCurrencySymbol:
      currency?.customCurrencySymbol?.trim() ||
      DEFAULT_CURRENCY_CONFIG.customCurrencySymbol,
  }
}

function getDisplayMeta(config: CurrencyConfig): DisplayMeta {
  switch (config.quotaDisplayType) {
    case 'CNY':
      return {
        kind: 'currency',
        symbol: '¥',
        currencyCode: 'CNY',
        exchangeRate: config.usdExchangeRate,
      }
    case 'CUSTOM':
      return {
        kind: 'custom',
        symbol: config.customCurrencySymbol,
        exchangeRate: config.customCurrencyExchangeRate,
      }
    case 'TOKENS':
      return {
        kind: 'tokens',
        quotaPerUnit: config.quotaPerUnit,
      }
    case 'USD':
    default:
      return {
        kind: 'currency',
        symbol: '$',
        currencyCode: 'USD',
        exchangeRate: 1,
      }
  }
}

function getBillingDisplayMeta(config: CurrencyConfig): DisplayMeta {
  const meta = getDisplayMeta(config)
  if (meta.kind === 'tokens') {
    return {
      kind: 'currency',
      symbol: '$',
      currencyCode: 'USD',
      exchangeRate: 1,
    }
  }
  return meta
}

function mergeOptions(
  options?: CurrencyFormatOptions
): ResolvedCurrencyFormatOptions {
  if (!options) return DEFAULT_FORMAT_OPTIONS
  return {
    digitsLarge: options.digitsLarge ?? DEFAULT_FORMAT_OPTIONS.digitsLarge,
    digitsSmall: options.digitsSmall ?? DEFAULT_FORMAT_OPTIONS.digitsSmall,
    abbreviate: options.abbreviate ?? DEFAULT_FORMAT_OPTIONS.abbreviate,
    minimumNonZero:
      options.minimumNonZero ?? DEFAULT_FORMAT_OPTIONS.minimumNonZero,
    compact: options.compact ?? DEFAULT_FORMAT_OPTIONS.compact,
    showSymbol: options.showSymbol ?? DEFAULT_FORMAT_OPTIONS.showSymbol,
    locale: options.locale ?? DEFAULT_FORMAT_OPTIONS.locale,
  }
}

function getFractionDigits(
  value: number,
  digitsLarge: number,
  digitsSmall: number
): number {
  return Math.abs(value) >= 1 ? digitsLarge : digitsSmall
}

export function getCurrencyFractionDigits(
  value: number,
  options?: CurrencyFormatOptions
): number {
  const merged = mergeOptions(options)
  return getFractionDigits(value, merged.digitsLarge, merged.digitsSmall)
}

function removeTrailingZeros(str: string): string {
  if (!str.includes('.')) return str
  return str.replace(/(\.[0-9]*?)0+$/, '$1').replace(/\.$/, '')
}

function formatNumberWithSuffix(
  value: number,
  digitsLarge: number,
  digitsSmall: number,
  abbreviate: boolean
): string {
  const abs = Math.abs(value)
  if (abbreviate && abs >= 1000) {
    const result = value / 1000
    return `${removeTrailingZeros(result.toFixed(1))}k`
  }

  const digits = getFractionDigits(value, digitsLarge, digitsSmall)
  return removeTrailingZeros(value.toFixed(digits))
}

function adjustForMinimum(
  value: number,
  digits: number,
  minimumNonZero: number
): number {
  if (value === 0) return value

  const threshold = minimumNonZero > 0 ? minimumNonZero : Math.pow(10, -digits)
  const abs = Math.abs(value)
  if (abs > 0 && abs < threshold) {
    return value > 0 ? threshold : -threshold
  }
  return value
}

function formatCurrencyValue(
  value: number,
  options: ResolvedCurrencyFormatOptions,
  meta: DisplayMeta
): string {
  if (meta.kind === 'tokens') {
    if (options.compact) {
      return new Intl.NumberFormat(options.locale, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value)
    }
    return formatNumberWithSuffix(
      value,
      options.digitsLarge,
      options.digitsSmall,
      options.abbreviate
    )
  }

  const digits = getFractionDigits(
    value,
    options.digitsLarge,
    options.digitsSmall
  )
  const adjustedValue = adjustForMinimum(value, digits, options.minimumNonZero)

  if (meta.kind === 'currency') {
    if (!options.showSymbol) {
      return new Intl.NumberFormat(options.locale, {
        notation: options.compact ? 'compact' : 'standard',
        minimumFractionDigits: 0,
        maximumFractionDigits: options.compact ? 1 : digits,
      }).format(adjustedValue)
    }

    const formatted = new Intl.NumberFormat(options.locale, {
      style: 'currency',
      currency: meta.currencyCode,
      currencyDisplay: 'narrowSymbol',
      notation: options.compact ? 'compact' : 'standard',
      minimumFractionDigits: 0,
      maximumFractionDigits: options.compact ? 1 : digits,
    }).format(adjustedValue)
    return formatted
  }

  const decimal = new Intl.NumberFormat(options.locale, {
    notation: options.compact ? 'compact' : 'standard',
    minimumFractionDigits: 0,
    maximumFractionDigits: options.compact ? 1 : digits,
  }).format(adjustedValue)

  return options.showSymbol ? `${meta.symbol} ${decimal}` : decimal
}

export function getCurrencyDisplay() {
  const config = getConfig()
  const meta = getDisplayMeta(config)
  return { config, meta }
}

export function formatCurrencyFromUSD(
  amountUSD: number | null | undefined,
  options?: CurrencyFormatOptions
): string {
  if (amountUSD == null || Number.isNaN(amountUSD)) return '-'

  const { config, meta } = getCurrencyDisplay()
  const merged = mergeOptions(options)

  if (meta.kind === 'tokens') {
    const tokens = amountUSD * config.quotaPerUnit
    if (merged.compact) {
      return new Intl.NumberFormat(merged.locale, {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(tokens)
    }
    return formatNumberWithSuffix(
      tokens,
      0,
      merged.digitsSmall,
      merged.abbreviate
    )
  }

  const value =
    meta.kind === 'currency'
      ? amountUSD * meta.exchangeRate
      : amountUSD * meta.exchangeRate

  return formatCurrencyValue(value, merged, meta)
}

export function formatBillingCurrencyFromUSD(
  amountUSD: number | null | undefined,
  options?: CurrencyFormatOptions
): string {
  if (amountUSD == null || Number.isNaN(amountUSD)) return '-'

  const { config } = getCurrencyDisplay()
  const meta = getBillingDisplayMeta(config)
  const merged = mergeOptions(options)
  const value =
    meta.kind === 'currency' || meta.kind === 'custom'
      ? amountUSD * meta.exchangeRate
      : amountUSD

  return formatCurrencyValue(value, merged, meta)
}

export function formatQuotaWithCurrency(
  quota: number | null | undefined,
  options?: CurrencyFormatOptions
): string {
  if (quota == null || Number.isNaN(quota)) return '-'

  const { config } = getCurrencyDisplay()
  const amountUSD = quota / config.quotaPerUnit
  return formatCurrencyFromUSD(amountUSD, options)
}

export function getCurrencyLabel(): string {
  const { config, meta } = getCurrencyDisplay()

  if (meta.kind === 'tokens') {
    return 'Tokens'
  }

  switch (config.quotaDisplayType) {
    case 'CNY':
      return 'CNY'
    case 'CUSTOM':
      return meta.kind === 'custom' ? meta.symbol : 'Custom'
    case 'USD':
    default:
      return 'USD'
  }
}

export function isCurrencyDisplayEnabled(): boolean {
  const { meta } = getCurrencyDisplay()
  return meta.kind !== 'tokens'
}

export function formatLocalCurrencyAmount(
  amount: number | null | undefined,
  options?: CurrencyFormatOptions
): string {
  if (amount == null || Number.isNaN(amount)) return '-'

  const { config } = getCurrencyDisplay()
  const meta = getBillingDisplayMeta(config)
  const merged = mergeOptions(options)

  return formatCurrencyValue(amount, merged, meta)
}
