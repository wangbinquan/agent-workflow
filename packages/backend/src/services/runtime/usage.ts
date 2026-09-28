import {
  ObservationMeasurementSchema,
  ObservationTokenUsageSchema,
  type ObservationMeasurement,
  type ObservationTokenUsage,
  ObservationCapturedUsageSchema,
  type ObservationCapturedUsage,
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

/** Freeze source sequence and invocation attribution before the runtime event commits. */
export function createInvocationUsageCapture(input: {
  readonly normalize?: (raw: unknown, context: RuntimeUsageContext) => RuntimeUsageFrame
  readonly invocationId: string
  readonly taskId: string
  readonly nodeRunId: string
  readonly agentId: string | null
  readonly resumeSessionId?: string
  readonly includeMeasurement?: (measurement: ObservationMeasurement) => boolean
}) {
  let revision = 0
  const nextRevision = () => ++revision
  const pending = new Map<string, { line: string; sessionId: string }>()
  const capture = (
    line: string,
    sessionId: string | null,
    observedAt: number,
  ): ObservationCapturedUsage | undefined => {
    if (!input.normalize) return undefined
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return undefined
    }
    if (!object(raw)) return undefined
    if (!sessionId)
      return {
        invocationId: input.invocationId,
        measurements: [],
        diagnostics: ['native-session-unavailable'],
      }
    try {
      const result = input.normalize(raw, {
        invocationId: input.invocationId,
        taskId: input.taskId,
        nodeRunId: input.nodeRunId,
        agentId: input.agentId,
        revision: nextRevision(),
        observedAt,
        rootSessionId: sessionId,
        sessionId,
        parentSessionId: null,
        ancestors: [],
        turnId: input.invocationId,
        turnIndex: 0,
        sessionStartTurn: 0,
        // Actual model/provider evidence may arrive later from the native transcript.
        // Configured defaults never stand in for a runtime report.
        provider: null,
        actualModel: null,
        cumulative: {
          kind: input.resumeSessionId ? 'native-session' : 'invocation',
          lineageKey: sessionId,
          modelBaselines: null,
        },
      })
      if (!result.measurements.length && !result.diagnostics.length) return undefined
      const evidence = ObservationCapturedUsageSchema.parse({
        invocationId: input.invocationId,
        ...result,
        measurements: result.measurements.filter((row) => input.includeMeasurement?.(row) ?? true),
      })
      const key = JSON.stringify(evidence.measurements.map((row) => row.recordId))
      if (
        evidence.measurements.length &&
        evidence.diagnostics.includes('native-model-unavailable')
      ) {
        if (pending.has(key) || pending.size < 200) pending.set(key, { line, sessionId })
        else evidence.diagnostics.push('native-model-retry-capacity')
      } else pending.delete(key)
      return evidence
    } catch {
      return {
        invocationId: input.invocationId,
        measurements: [],
        diagnostics: ['usage-normalization-failed'],
      }
    }
  }
  return Object.assign(capture, {
    nextRevision,
    retryModels(observedAt: number, budgetMs = 50): ObservationCapturedUsage[] {
      const rows: ObservationCapturedUsage[] = [],
        deadline = performance.now() + budgetMs
      for (const { line, sessionId } of [...pending.values()]) {
        if (performance.now() >= deadline) {
          rows.push({
            invocationId: input.invocationId,
            measurements: [],
            diagnostics: ['native-model-retry-budget'],
          })
          break
        }
        const result = capture(line, sessionId, observedAt)
        if (result && !result.diagnostics.includes('native-model-unavailable')) rows.push(result)
      }
      return rows
    },
  })
}
