import type { TFunction } from 'i18next'

export type NumberRangeUnit = 'ms' | 'bytes' | 'days'

type LocalizedUnitKey = 'unit.hour' | 'unit.minute' | 'unit.second' | 'unit.year' | 'unit.day'

type UnitStep =
  | { factor: number; key: LocalizedUnitKey }
  | { factor: number; suffix: 'MiB' | 'KiB' }

const UNIT_STEPS: Record<NumberRangeUnit, readonly UnitStep[]> = {
  ms: [
    { factor: 3_600_000, key: 'unit.hour' },
    { factor: 60_000, key: 'unit.minute' },
    { factor: 1_000, key: 'unit.second' },
  ],
  days: [
    { factor: 365, key: 'unit.year' },
    { factor: 1, key: 'unit.day' },
  ],
  bytes: [
    { factor: 1024 * 1024, suffix: 'MiB' },
    { factor: 1024, suffix: 'KiB' },
  ],
}

/**
 * RFC-290: convert a raw bounded-setting value into one compact human unit.
 *
 * The value's magnitude selects exactly one tier. A non-integral result does
 * not fall through to a smaller tier: 90_000ms is 1.5 minutes, so returning
 * "90 seconds" would hide the useful scale and violate the no-noise contract.
 * `t` is injected to keep this helper independent from process-global i18n
 * state and directly testable in either locale.
 */
export function formatUnitValue(value: number, unit: NumberRangeUnit, t: TFunction): string | null {
  if (!Number.isFinite(value)) return null
  if (value === 0) return '0'

  const magnitude = Math.abs(value)
  const step = UNIT_STEPS[unit].find((candidate) => magnitude >= candidate.factor)
  if (step === undefined || value % step.factor !== 0) return null

  const count = value / step.factor
  if ('suffix' in step) return `${count} ${step.suffix}`
  return t(step.key, { count })
}
