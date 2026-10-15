import { z } from 'zod'
import type { TaskStatus } from './task'

// RFC-371 v2 (design/RFC-371-run-observability/redesign-v2-20261014.md) — the
// HTTP contract of run observation. Statistics are aggregated on demand from one
// row per runtime call; every number here is an exact integer (tokens, CNY nano-yuan).

export const OBSERVATION_CALL_STATUSES = [
  'running',
  'done',
  'failed',
  'canceled',
  'interrupted',
] as const
export type ObservationCallStatus = (typeof OBSERVATION_CALL_STATUSES)[number]
/** pending: running with no usage yet; partial: a lower bound; none: ended unreported. */
export const OBSERVATION_USAGE_STATES = ['pending', 'partial', 'complete', 'none'] as const
export type ObservationUsageState = (typeof OBSERVATION_USAGE_STATES)[number]
export const OBSERVATION_COST_STATES = ['none', 'priced', 'partial', 'unpriced'] as const
export type ObservationCostState = (typeof OBSERVATION_COST_STATES)[number]

/** The longest window one request may aggregate. */
export const OBSERVATION_MAX_WINDOW_MS = 366 * 86_400_000

export const ObservationWindowQuerySchema = z
  .object({
    from: z.coerce.number().int().min(0),
    to: z.coerce.number().int().min(1),
    /** Minutes east of UTC used to cut daily buckets (e.g. 480 for UTC+8). */
    tzOffset: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= OBSERVATION_MAX_WINDOW_MS, {
    message: 'invalid-window',
  })
export type ObservationWindowQuery = z.infer<typeof ObservationWindowQuerySchema>

export const ObservationTaskPageQuerySchema = z
  .object({
    from: z.coerce.number().int().min(0),
    to: z.coerce.number().int().min(1),
    q: z.string().trim().min(1).max(200).optional(),
    status: z.string().trim().min(1).max(40).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= OBSERVATION_MAX_WINDOW_MS, {
    message: 'invalid-window',
  })
export type ObservationTaskPageQuery = z.infer<typeof ObservationTaskPageQuerySchema>

export const ObservationSystemQuerySchema = z
  .object({
    from: z.coerce.number().int().min(0),
    to: z.coerce.number().int().min(1),
    kind: z.string().trim().min(1).max(100).optional(),
    cursor: z.string().min(1).max(200).optional(),
  })
  .refine((v) => v.to > v.from && v.to - v.from <= OBSERVATION_MAX_WINDOW_MS, {
    message: 'invalid-window',
  })
export type ObservationSystemQuery = z.infer<typeof ObservationSystemQuerySchema>

/** Additive totals of a set of calls. */
export interface ObservationUsage {
  readonly calls: number
  /** Calls whose usage is pending, partial or unreported: totals are a lower bound. */
  readonly incompleteCalls: number
  readonly failedCalls: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** Includes reasoning; reasoning is its known subset, never added twice. */
  readonly output: number
  readonly reasoning: number
  /** CNY in nano-yuan (10⁻⁹) of the priced part. */
  readonly costNano: number
  /** Calls with tokens but no (or partial) price. */
  readonly unpricedCalls: number
}

export interface ObservationTaskCounts {
  readonly total: number
  readonly done: number
  readonly failed: number
  readonly canceled: number
  /** pending + running. */
  readonly running: number
  /** awaiting review or a human answer. */
  readonly waiting: number
  readonly interrupted: number
  /** Wall-clock of finished tasks, nearest rank; null without samples. */
  readonly durationSamples: number
  readonly durationP50: number | null
  readonly durationP95: number | null
  readonly durationMax: number | null
}

export interface ObservationDay {
  /** Local calendar day `YYYY-MM-DD` at the requested offset. */
  readonly day: string
  readonly calls: number
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly costNano: number
}

export interface ObservationTaskRef {
  readonly taskId: string
  /** null when the task no longer exists. */
  readonly name: string | null
  readonly usage: ObservationUsage
}

export interface ObservationAgentRow {
  readonly agentId: string | null
  readonly agentName: string
  readonly tasks: number
  readonly durationMs: number
  readonly usage: ObservationUsage
}

export interface ObservationOverview {
  readonly asOf: number
  readonly from: number
  readonly to: number
  /** The caller's visible scope exceeded the read budget; totals are a subset. */
  readonly partial: boolean
  readonly usage: ObservationUsage
  readonly taskUsage: ObservationUsage
  readonly systemUsage: ObservationUsage
  readonly tasks: ObservationTaskCounts
  readonly daily: readonly ObservationDay[]
  readonly topTasks: readonly ObservationTaskRef[]
  readonly topAgents: readonly ObservationAgentRow[]
}

export interface ObservationTaskRow {
  readonly taskId: string
  readonly name: string
  readonly status: TaskStatus
  /** When the task was started (its submission); the task list cohort. */
  readonly startedAt: number
  readonly finishedAt: number | null
  readonly agents: number
  readonly usage: ObservationUsage
}

export interface ObservationTaskPage {
  readonly asOf: number
  readonly items: readonly ObservationTaskRow[]
  readonly nextCursor: string | null
}

export interface ObservationModelUsage {
  readonly model: string
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
  /** null: unpriced. */
  readonly costNano: number | null
}

export interface ObservationCall {
  readonly id: string
  readonly purpose: 'task' | 'system'
  readonly taskId: string | null
  readonly systemKind: string | null
  readonly systemLabel: string | null
  readonly nodeRunId: string | null
  readonly nodeId: string | null
  readonly attempt: number | null
  readonly agentId: string | null
  readonly agentName: string
  /** Price-line key: a runtime registration id, or a built-in runtime key. */
  readonly runtimeId: string | null
  readonly runtimeName: string | null
  readonly protocol: string
  readonly status: ObservationCallStatus
  readonly startedAt: number
  readonly endedAt: number | null
  readonly usageState: ObservationUsageState
  readonly costState: ObservationCostState
  readonly input: number
  readonly cacheRead: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
  readonly costNano: number
  readonly models: readonly ObservationModelUsage[]
}

export interface ObservationTaskDetail {
  readonly asOf: number
  readonly task: {
    readonly id: string
    readonly name: string
    readonly status: TaskStatus
    readonly startedAt: number
    readonly finishedAt: number | null
    /** Accumulated running time maintained by task execution. */
    readonly runningMs: number
  }
  readonly usage: ObservationUsage
  readonly calls: readonly ObservationCall[]
  /** More calls exist than one response carries. */
  readonly truncated: boolean
}

export interface ObservationAgentPage {
  readonly asOf: number
  readonly partial: boolean
  readonly truncated: boolean
  readonly items: readonly ObservationAgentRow[]
}

export interface ObservationModelRow {
  readonly runtimeId: string | null
  readonly runtimeName: string | null
  readonly protocol: string
  readonly model: string
  readonly usage: ObservationUsage
}

export interface ObservationModelPage {
  readonly asOf: number
  readonly partial: boolean
  readonly truncated: boolean
  readonly items: readonly ObservationModelRow[]
}

export interface ObservationSystemKind {
  readonly kind: string
  readonly label: string | null
  readonly usage: ObservationUsage
}

export interface ObservationSystemPage {
  readonly asOf: number
  readonly partial: boolean
  readonly kinds: readonly ObservationSystemKind[]
  readonly recent: readonly ObservationCall[]
  readonly nextCursor: string | null
}

// -- Pricing -----------------------------------------------------------------

/** CNY per million tokens, at most 6 decimals (and below ¥1e9, so the integer
 * micro-yuan form stays a safe integer); null is unknown, never free. */
export const ObservationRateSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,8})(\.\d{1,6})?$/)
  .nullable()
export const ObservationRatesSchema = z
  .object({
    input: ObservationRateSchema,
    cacheRead: ObservationRateSchema,
    cacheWrite: ObservationRateSchema,
    output: ObservationRateSchema,
  })
  .strict()
export type ObservationRates = z.infer<typeof ObservationRatesSchema>

export const SaveObservationPriceSchema = z
  .object({
    model: z.string().trim().min(1).max(300),
    rates: ObservationRatesSchema,
    effectiveFrom: z.number().int().min(0),
    note: z.string().trim().max(2000).default(''),
    /** Compare-and-set against the newest version of this price line. */
    expectedLatestId: z.string().min(1).max(64).nullable(),
  })
  .strict()
export type SaveObservationPrice = z.infer<typeof SaveObservationPriceSchema>

export interface ObservationPrice {
  readonly id: string
  readonly runtimeId: string
  readonly model: string
  readonly rates: ObservationRates
  readonly effectiveFrom: number
  readonly createdAt: number
  readonly createdBy: string
  readonly note: string
}

export interface ObservationPriceLine {
  readonly model: string
  /** Calls of this runtime that reported this model. */
  readonly calls: number
  readonly current: ObservationPrice | null
}

export interface ObservationPricingRuntime {
  readonly runtimeId: string
  readonly name: string
  readonly protocol: string
  /** A protocol's built-in default runtime rather than a registration. */
  readonly builtin: boolean
  readonly configuredModel: string | null
  readonly models: readonly ObservationPriceLine[]
}

export interface ObservationPricingDirectory {
  readonly runtimes: readonly ObservationPricingRuntime[]
}

export interface ObservationPriceHistory {
  readonly items: readonly ObservationPrice[]
}

/**
 * A call that ran without a runtime registration (a system agent configured
 * through a legacy `*Model` setting, or a protocol fallback) used the
 * protocol's built-in default runtime. It keeps a price line of its own,
 * keyed `builtin:<protocol>`, so it can be priced like any registration.
 */
export const OBSERVATION_BUILTIN_PROTOCOLS = ['opencode', 'claude-code'] as const
const BUILTIN_RUNTIME_PREFIX = 'builtin:'

export function observationBuiltinRuntimeId(protocol: string): string {
  return `${BUILTIN_RUNTIME_PREFIX}${protocol}`
}

/** The protocol of a built-in runtime key, or null for a registration id. */
export function observationBuiltinProtocol(runtimeId: string | null): string | null {
  return runtimeId !== null && runtimeId.startsWith(BUILTIN_RUNTIME_PREFIX)
    ? runtimeId.slice(BUILTIN_RUNTIME_PREFIX.length)
    : null
}

const RATE_PATTERN = /^(0|[1-9]\d{0,8})(?:\.(\d{1,6}))?$/

/** `"2.5"` → 2_500_000 micro-yuan per million tokens. */
export function observationRateToMicro(rate: string): number {
  const match = RATE_PATTERN.exec(rate)
  if (!match) throw new RangeError('invalid-rate')
  return Number(match[1]) * 1_000_000 + Number((match[2] ?? '').padEnd(6, '0') || '0')
}

/** 2_500_000 → `"2.5"`. */
export function observationMicroToRate(micro: number): string {
  const whole = Math.floor(micro / 1_000_000)
  const fraction = String(micro % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

/** Nano-yuan → `¥` amount with at most 6 decimals; tiny non-zero amounts are marked. */
export function formatObservationCny(nano: number): string {
  if (nano > 0 && nano < 1000) return '< ¥0.000001'
  const micro = Math.round(nano / 1000)
  const whole = Math.floor(micro / 1_000_000)
  const fraction = String(micro % 1_000_000)
    .padStart(6, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0')
  return `¥${whole.toLocaleString('en-US')}.${fraction}`
}
