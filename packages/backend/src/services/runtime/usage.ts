import {
  ObservationMeasurementSchema,
  ObservationTokenUsageSchema,
  type ObservationMeasurement,
  type ObservationTokenUsage,
} from '@agent-workflow/shared'
export const TOKEN_BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output'] as const

export type JsonObject = Record<string, unknown>
export interface RuntimeUsageContext {
  readonly invocationId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly agentId: string | null
  /** Persisted source sequence, never the consumer's delivery order. */
  readonly revision: number
  readonly observedAt: number
  /** Owner-proven root/session mapping, including child transcript capture. */
  readonly rootSessionId: string
  readonly sessionId: string
  readonly parentSessionId: string | null
  readonly ancestors: readonly string[]
  /** Durable native turn correlation; separate turns may share one invocation. */
  readonly turnId: string
  readonly turnIndex: number
  readonly sessionStartTurn: number
  /** The actual provider route, not a guessed model-name prefix. */
  readonly provider: string | null
  readonly actualModel: string | null
  /** Explicit protocol contract established at acceptance. Unknown resumed
   * counters use a null baseline; they are never charged as new call usage. */
  readonly cumulative: {
    readonly kind: 'invocation' | 'native-session'
    readonly lineageKey: string
    readonly modelBaselines: Readonly<Record<string, ObservationTokenUsage>> | null
  }
}
export interface RuntimeUsageFrame {
  readonly measurements: readonly ObservationMeasurement[]
  readonly diagnostics: readonly string[]
}
export const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
export const nativeId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null

export function readUsage(values: Record<keyof ObservationTokenUsage, unknown>, issues: string[]) {
  const read = (bucket: keyof ObservationTokenUsage) => {
    const value = values[bucket]
    const exact =
      typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
        ? String(value)
        : (value ?? null)
    const parsed = ObservationTokenUsageSchema.shape[bucket].safeParse(exact)
    if (parsed.success) return parsed.data
    issues.push('invalid-token-count:' + bucket)
    return null
  }
  return {
    input: read('input'),
    cacheRead: read('cacheRead'),
    cacheWrite: read('cacheWrite'),
    output: read('output'),
  }
}
function timestamp(value: unknown): number | null {
  const time = typeof value === 'string' ? Date.parse(value) : value
  return typeof time === 'number' && Number.isSafeInteger(time) && time >= 0 ? time : null
}
export function common(c: RuntimeUsageContext, raw: JsonObject) {
  return {
    schemaVersion: 1 as const,
    invocationId: c.invocationId,
    taskId: c.taskId,
    nodeRunId: c.nodeRunId,
    agentId: c.agentId,
    revision: c.revision,
    occurredAt: timestamp(raw.timestamp),
    observedAt: c.observedAt,
  }
}
export function model(c: RuntimeUsageContext, id: string | null) {
  return id ? { provider: c.provider, id } : null
}
export function scope(c: RuntimeUsageContext, level: 'request' | 'self-total' | 'tree-total') {
  return {
    root: c.rootSessionId,
    session: c.sessionId,
    parentSession: c.parentSessionId,
    ancestors: [...c.ancestors],
    turn: level === 'tree-total' ? 'session-total' : c.turnId,
    turnIndex: level === 'tree-total' ? c.sessionStartTurn : c.turnIndex,
    level,
  }
}

/** Drivers own protocol parsing; this neutral boundary validates the resulting evidence. */
export function normalizeUsageFrame(
  raw: unknown,
  context: RuntimeUsageContext,
  parse: (
    event: JsonObject,
    context: RuntimeUsageContext,
    diagnostics: string[],
  ) => ObservationMeasurement[],
): RuntimeUsageFrame {
  const event = object(raw),
    diagnostics: string[] = []
  if (!event) return { measurements: [], diagnostics: ['invalid-runtime-event'] }
  const measurements: ObservationMeasurement[] = []
  for (const row of parse(event, context, diagnostics)) {
    const parsed = ObservationMeasurementSchema.safeParse(row)
    if (parsed.success) measurements.push(parsed.data)
    else diagnostics.push('invalid-measurement-identity')
  }
  return { measurements, diagnostics }
}
