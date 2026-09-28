import {
  ObservationMeasurementSchema,
  type ObservationMeasurement,
  type ObservationTokenUsage,
} from '@agent-workflow/shared'
import { TOKEN_BUCKETS, tokenCount } from './tokenUsage'

type JsonObject = Record<string, unknown>
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
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
const nativeId = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null

function readUsage(values: Record<keyof ObservationTokenUsage, unknown>, issues: string[]) {
  const read = (bucket: keyof ObservationTokenUsage) => {
    try {
      return tokenCount(values[bucket])
    } catch {
      issues.push('invalid-token-count:' + bucket)
      return null
    }
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
function common(c: RuntimeUsageContext, raw: JsonObject) {
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
function model(c: RuntimeUsageContext, id: string | null) {
  return id ? { provider: c.provider, id } : null
}
function scope(c: RuntimeUsageContext, level: 'request' | 'self-total' | 'tree-total') {
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
function opencode(
  raw: JsonObject,
  c: RuntimeUsageContext,
  diagnostics: string[],
): ObservationMeasurement[] {
  if (raw.type !== 'step_finish') return []
  const part = object(raw.part),
    tokens = object(part?.tokens)
  const id = nativeId(part?.id)
  if (!id) {
    diagnostics.push('missing-step-identity')
    return []
  }
  const cache = object(tokens?.cache)
  const usage = readUsage(
    {
      input: tokens?.input,
      output: tokens?.output,
      cacheRead: cache?.read,
      cacheWrite: cache?.write,
    },
    diagnostics,
  )
  return [
    {
      ...common(c, raw),
      recordId: 'opencode:step:' + id,
      adapterVersion: 'opencode-step-finish/1.15.5@1',
      reporting: 'delta',
      inclusion: 'self',
      model: model(c, c.actualModel),
      coverage: TOKEN_BUCKETS.every((b) => usage[b] !== null) ? 'complete' : 'partial',
      validity: 'valid',
      basis: { kind: 'invocation' },
      usage,
      scope: scope(c, 'request'),
    },
  ]
}
function claude(
  raw: JsonObject,
  c: RuntimeUsageContext,
  diagnostics: string[],
): ObservationMeasurement[] {
  if (raw.type !== 'assistant' && raw.type !== 'result') return []
  // A sidechain frame cannot inherit the root's attribution without its owner mapping.
  if ((raw.parent_tool_use_id != null || raw.isSidechain === true) && c.parentSessionId === null) {
    diagnostics.push('unmapped-child-session')
    return []
  }
  const message = object(raw.message)
  if (raw.type === 'assistant') {
    const id = nativeId(message?.id)
    if (!id) {
      diagnostics.push('missing-message-identity')
      return []
    }
    const u = object(message?.usage)
    const usage = readUsage(
      {
        input: u?.input_tokens,
        output: null,
        cacheRead: u?.cache_read_input_tokens,
        cacheWrite: u?.cache_creation_input_tokens,
      },
      diagnostics,
    )
    return [
      {
        ...common(c, raw),
        recordId: 'claude:message:' + id,
        adapterVersion: 'claude-stream-json/cost-contract@1',
        reporting: 'delta',
        inclusion: 'self',
        model: model(c, nativeId(message?.model)),
        coverage: 'partial',
        validity: 'valid',
        basis: { kind: 'invocation' },
        usage,
        scope: scope(c, 'request'),
      },
    ]
  }
  const models = object(raw.modelUsage)
  const entries = models
    ? Object.entries(models).filter(([id, value]) => nativeId(id) && object(value))
    : []
  if (entries.length)
    return entries.map(([id, value]) => {
      const u = object(value)!
      const usage = readUsage(
        {
          input: u.inputTokens,
          output: u.outputTokens,
          cacheRead: u.cacheReadInputTokens,
          cacheWrite: u.cacheCreationInputTokens,
        },
        diagnostics,
      )
      const invalid =
        raw.subtype === 'error_during_execution' && TOKEN_BUCKETS.every((b) => usage[b] === '0')
      return {
        ...common(c, raw),
        recordId: 'claude:tree:' + c.sessionId + ':' + id,
        adapterVersion: 'claude-stream-json/cost-contract@1',
        reporting: 'cumulative',
        inclusion: 'includes-descendants',
        model: model(c, id),
        coverage: TOKEN_BUCKETS.every((b) => usage[b] !== null) ? 'complete' : 'partial',
        validity: invalid ? 'invalid-final' : 'valid',
        coveredThroughTurn: c.turnIndex,
        usage,
        basis:
          c.cumulative.kind === 'invocation'
            ? { kind: 'invocation' }
            : {
                kind: 'native-session',
                lineageKey: c.cumulative.lineageKey,
                baseline: c.cumulative.modelBaselines?.[id] ?? null,
              },
        scope: scope(c, 'tree-total'),
      }
    })
  const u = object(raw.usage),
    resultId = nativeId(raw.uuid)
  if (!resultId) {
    diagnostics.push('missing-result-identity')
    return []
  }
  const usage = readUsage(
    {
      input: u?.input_tokens,
      output: u?.output_tokens,
      cacheRead: u?.cache_read_input_tokens,
      cacheWrite: u?.cache_creation_input_tokens,
    },
    diagnostics,
  )
  const invalid =
    raw.subtype === 'error_during_execution' && TOKEN_BUCKETS.every((b) => usage[b] === '0')
  return [
    {
      ...common(c, raw),
      recordId: 'claude:main:' + c.sessionId + ':' + c.turnId,
      adapterVersion: 'claude-stream-json/cost-contract@1',
      reporting: 'cumulative',
      inclusion: 'self',
      // Main-loop totals can contain several models; never assign the configured model.
      model: null,
      coverage: TOKEN_BUCKETS.every((b) => usage[b] !== null) ? 'complete' : 'partial',
      validity: invalid ? 'invalid-final' : 'valid',
      coveredThroughTurn: c.turnIndex,
      basis: { kind: 'invocation' },
      usage,
      scope: scope(c, 'self-total'),
    },
  ]
}

/** Numeric protocol evidence only. Vendor currency estimates and reasoning
 * subsets never enter the four mutually exclusive token buckets. */
export function normalizeRuntimeUsage(
  protocol: 'opencode' | 'claude-code',
  raw: unknown,
  context: RuntimeUsageContext,
): RuntimeUsageFrame {
  const event = object(raw),
    diagnostics: string[] = []
  if (!event) return { measurements: [], diagnostics: ['invalid-runtime-event'] }
  const rows =
    protocol === 'opencode'
      ? opencode(event, context, diagnostics)
      : claude(event, context, diagnostics)
  const measurements: ObservationMeasurement[] = []
  for (const row of rows) {
    const parsed = ObservationMeasurementSchema.safeParse(row)
    if (parsed.success) measurements.push(parsed.data)
    else diagnostics.push('invalid-measurement-identity')
  }
  return { measurements, diagnostics }
}
