import type { BusinessEvent } from '@/platform/crewstation/businessExecution'
import type { NormalizedEvent, NormalizedTokenDelta } from '@/services/runtime/types'
import {
  readHostedStartupInventory,
  hostedStartupObservation,
  startupInventoryFaces,
} from '@/platform/crewstation/startupInventory'
import type {
  RuntimeUsageMeter,
  RuntimeUsageSnapshot,
} from '@/modules/runtime-management/public/participants'
import { objectOf } from '@/modules/runtime-management/public/participants'

export const HOSTED_EVENT_FORMAT = 'aw-normalized-execution-v1'

export function hostedEventRecord(
  event: BusinessEvent,
  protocol?: 'opencode' | 'claude-code',
): {
  readonly raw: string
  readonly event: NormalizedEvent
} {
  if (event.type === 'startup-inventory') {
    const report =
      protocol === undefined
        ? {
            version: 1 as const,
            state: 'unavailable' as const,
            reason: 'hosted-inventory-protocol-unknown',
          }
        : readHostedStartupInventory(event.data, protocol)
    const observation = hostedStartupObservation(report)
    const faces = startupInventoryFaces(observation)
    const raw = JSON.stringify({ format: HOSTED_EVENT_FORMAT, event: { ...event, data: report } })
    return {
      raw,
      event: {
        rawLine: raw,
        timestamp: Date.parse(event.occurredAt),
        kind: 'startup_inventory',
        persist: false,
        data: {
          startupObservation: observation,
          ...(faces === null ? {} : { inventory: { faces } }),
        },
      },
    }
  }
  const raw = JSON.stringify({ format: HOSTED_EVENT_FORMAT, event })
  const common = { rawLine: raw, timestamp: Date.parse(event.occurredAt) }
  switch (event.type) {
    case 'text':
      return { raw, event: { ...common, kind: 'text', text: event.data.text } }
    case 'session':
      return { raw, event: { ...common, kind: 'step_start', sessionId: event.data.sessionId } }
    case 'tool-start':
    case 'tool-end':
      return { raw, event: { ...common, kind: 'tool_use' } }
    case 'result':
      return {
        raw,
        event: { ...common, kind: event.data.exitCode === 0 ? 'step_finish' : 'error' },
      }
    default:
      return { raw, event: { ...common, kind: 'step_finish' } }
  }
}

/** RFC-370 §9.2 V1 — token deltas for the node's running totals (`tok_*`,
 * enforced by `max_total_tokens`). Platform usage is a replacement snapshot;
 * each delta is the growth since the previous snapshot, never negative. */
export function createHostedTokenDeltas(): (
  raw: Readonly<Record<string, unknown>>,
) => NormalizedTokenDelta | undefined {
  const meter = createHostedUsageMeter()
  let emitted: NormalizedTokenDelta = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
  return (raw) => {
    if (!meter.observe(raw)) return undefined
    const totals = meter.snapshot().models.reduce(
      (sum, model) => ({
        input: sum.input + model.input,
        output: sum.output + model.output,
        cacheCreate: sum.cacheCreate + model.cacheWrite,
        cacheRead: sum.cacheRead + model.cacheRead,
      }),
      { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    )
    const delta: NormalizedTokenDelta = {
      input: Math.max(0, totals.input - emitted.input),
      output: Math.max(0, totals.output - emitted.output),
      cacheCreate: Math.max(0, totals.cacheCreate - emitted.cacheCreate),
      cacheRead: Math.max(0, totals.cacheRead - emitted.cacheRead),
    }
    emitted = {
      input: Math.max(emitted.input, totals.input),
      output: Math.max(emitted.output, totals.output),
      cacheCreate: Math.max(emitted.cacheCreate, totals.cacheCreate),
      cacheRead: Math.max(emitted.cacheRead, totals.cacheRead),
    }
    return delta.input + delta.output + delta.cacheCreate + delta.cacheRead > 0 ? delta : undefined
  }
}

export function readHostedEvent(value: unknown): BusinessEvent | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as { format?: unknown; event?: unknown }
  if (
    record.format !== HOSTED_EVENT_FORMAT ||
    record.event === null ||
    typeof record.event !== 'object'
  )
    return null
  return record.event as BusinessEvent
}

/** RFC-034 v2 snapshots are the same model-level replacement contract as
 * RFC-371 v2. Unknown usage remains partial; configured models are not billed
 * as though the platform had actually reported them. */
export function createHostedUsageMeter(): RuntimeUsageMeter {
  let snapshot: RuntimeUsageSnapshot = { state: 'partial', models: [] }
  const measurements = new Map<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  >()
  const seen = new Set<string>()
  return {
    observe(raw) {
      const event = readHostedEvent(raw)
      if (event?.type !== 'usage' || seen.has(event.sourceEventId)) return false
      seen.add(event.sourceEventId)
      if (event.data.snapshot !== undefined) {
        const candidate = objectOf(event.data.snapshot)
        if (
          candidate === undefined ||
          !['partial', 'complete'].includes(String(candidate.state)) ||
          !Array.isArray(candidate.models) ||
          candidate.models.length > 100 ||
          !candidate.models.every((raw) => {
            const row = objectOf(raw)
            return (
              row !== undefined &&
              typeof row.model === 'string' &&
              ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'].every(
                (key) =>
                  typeof row[key] === 'number' &&
                  Number.isSafeInteger(row[key]) &&
                  Number(row[key]) >= 0,
              ) &&
              Number(row.reasoning) <= Number(row.output)
            )
          })
        )
          throw new Error('hosted-usage-snapshot-invalid')
        snapshot = candidate as unknown as RuntimeUsageSnapshot
        return true
      }
      const data = event.data
      const previous = measurements.get(data.scope) ?? {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      }
      const counts = {
        input: data.inputTokens ?? 0,
        output: data.outputTokens ?? 0,
        cacheRead: data.cacheReadTokens ?? 0,
        cacheWrite: data.cacheWriteTokens ?? 0,
      }
      measurements.set(
        data.scope,
        data.mode === 'cumulative'
          ? counts
          : {
              input: previous.input + counts.input,
              output: previous.output + counts.output,
              cacheRead: previous.cacheRead + counts.cacheRead,
              cacheWrite: previous.cacheWrite + counts.cacheWrite,
            },
      )
      const totals = [...measurements.values()].reduce(
        (sum, value) => ({
          input: sum.input + value.input,
          output: sum.output + value.output,
          cacheRead: sum.cacheRead + value.cacheRead,
          cacheWrite: sum.cacheWrite + value.cacheWrite,
        }),
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      )
      snapshot = {
        state:
          data.complete &&
          [data.inputTokens, data.outputTokens, data.cacheReadTokens, data.cacheWriteTokens].every(
            (value) => value !== null,
          )
            ? 'complete'
            : 'partial',
        models: [{ model: '', ...totals, reasoning: 0 }],
      }
      return true
    },
    snapshot: () => snapshot,
  }
}
