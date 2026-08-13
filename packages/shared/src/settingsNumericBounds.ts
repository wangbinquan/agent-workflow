/**
 * Numeric limits for fields that are actually editable in Settings.
 *
 * This is deliberately independent from the Config schema so the frontend,
 * PATCH validator, and runtime-row validator all consume the same values.
 * It does not inventory hidden config or add new Settings capabilities.
 */

export const JS_TIMER_MAX_MS = 2_147_483_647

export type SettingsNumericUnit = 'ms' | 'bytes' | 'days'

export interface SettingsNumericBound {
  readonly min: number
  readonly max: number
  readonly step?: number
  readonly unit?: SettingsNumericUnit
  /** Zero is valid; non-zero values must be at least this value. */
  readonly positiveMin?: number
  readonly valueKind?: 'integer' | 'decimal'
}

export const SETTINGS_NUMERIC_BOUNDS = {
  defaultPerTaskMaxDurationMs: {
    min: 0,
    max: 31_536_000_000,
    step: 60_000,
    unit: 'ms',
  },
  defaultPerTaskMaxTotalTokens: { min: 0, max: 1_000_000_000 },
  defaultPerNodeTimeoutMs: {
    min: 1_000,
    max: JS_TIMER_MAX_MS,
    step: 1_000,
    unit: 'ms',
  },
  defaultNodeRetries: { min: 0, max: 50 },
  largeOutputThresholdBytes: {
    min: 1_024,
    max: 268_435_456,
    step: 1_024,
    unit: 'bytes',
  },
  maxConcurrentNodes: { min: 1, max: 256 },
  maxConcurrentScriptNodes: { min: 1, max: 256 },
  multiProcessSubprocessConcurrency: { min: 1, max: 256 },
  heartbeatStallMs: {
    min: 1_000,
    max: JS_TIMER_MAX_MS,
    step: 1_000,
    unit: 'ms',
  },
  maxAutoRecoveriesPerWindow: { min: 1, max: 100 },
  autoRecoveryWindowMs: {
    min: 1_000,
    max: JS_TIMER_MAX_MS,
    step: 1_000,
    unit: 'ms',
  },
  periodicOrphanReconcileMs: {
    min: 0,
    positiveMin: 60_000,
    max: JS_TIMER_MAX_MS,
    step: 60_000,
    unit: 'ms',
  },
  gitSubmoduleJobs: { min: 1, max: 32 },
  'submoduleAutoRefresh.intervalMs': {
    min: 60_000,
    max: 604_800_000,
    step: 60_000,
    unit: 'ms',
  },
  'submoduleAutoRefresh.onlyRecentDays': { min: 1, max: 3_650, unit: 'days' },
  'worktreeAutoGc.olderThanDays': { min: 1, max: 3_650, unit: 'days' },
  'eventsArchiveThresholds.perNodeRunRows': { min: 1_000, max: JS_TIMER_MAX_MS },
  'eventsArchiveThresholds.globalRows': { min: 10_000, max: JS_TIMER_MAX_MS },
  webhookDeliveryBodyRetentionDays: { min: 1, max: 3_650, unit: 'days' },
  webhookDeliveryRowRetentionDays: { min: 1, max: 3_650, unit: 'days' },
  bindPort: { min: 0, max: 65_535 },
  commitPushMaxRepairRetries: { min: 0, max: 10 },
  commitPushDiffMaxBytes: { min: 0, max: 262_144, unit: 'bytes' },
  intentBuilderTurnTimeoutMs: {
    min: 30_000,
    max: 3_600_000,
    step: 1_000,
    unit: 'ms',
  },
  intentBuilderMaxGenerateRounds: { min: 1, max: 500 },
} as const satisfies Record<string, SettingsNumericBound>

export type SettingsNumericPath = keyof typeof SETTINGS_NUMERIC_BOUNDS

export const RUNTIME_NUMERIC_BOUNDS = {
  temperature: { min: 0, max: 2, step: 0.1, valueKind: 'decimal' },
  steps: { min: 1, max: 1_000 },
  maxSteps: { min: 1, max: 1_000 },
} as const satisfies Record<string, SettingsNumericBound>

export type RuntimeNumericPath = keyof typeof RUNTIME_NUMERIC_BOUNDS

export function isNumericSettingValueWithinBound(
  value: number,
  bound: SettingsNumericBound,
): boolean {
  if (!Number.isFinite(value)) return false
  if ((bound.valueKind ?? 'integer') === 'integer' && !Number.isSafeInteger(value)) return false
  if (value < bound.min || value > bound.max) return false
  return bound.positiveMin === undefined || value === 0 || value >= bound.positiveMin
}
