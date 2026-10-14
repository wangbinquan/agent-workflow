// RFC-371 v2 §4 — the write side: accept before spawn, replace usage in place,
// end once. Writes for one call are serialized here so a late progress update
// can never overwrite the final snapshot.

import type { CallObservations, CallObservationLifecycle } from './callObservations'
import type { CallStore, PricedModelUsage } from './ports/callStore'
import type { PriceStore } from './ports/priceStore'
import {
  normalizeObservedUsage,
  sumBuckets,
  totalTokens,
  usageStateOf,
  type ObservedUsage,
} from '../domain/usage'
import { callCostState, modelCost, selectPrice } from '../domain/pricing'

export function createCallRecorder(deps: {
  readonly store: CallStore
  /** Price lines are read per write: a few indexed rows, never cached across saves. */
  readonly prices: Pick<PriceStore, 'line'>
  readonly clock?: () => number
}): CallObservations & CallObservationLifecycle {
  const clock = deps.clock ?? Date.now
  const queues = new Map<string, Promise<void>>()

  function enqueue(callId: string, operation: () => Promise<void>): Promise<void> {
    // The stored tail never rejects; the caller still sees this write's own outcome.
    const next = (queues.get(callId) ?? Promise.resolve()).then(operation)
    const release = () => {
      if (queues.get(callId) === settled) queues.delete(callId)
    }
    const settled: Promise<void> = next.then(release, release)
    queues.set(callId, settled)
    return next
  }

  async function priced(
    runtimeId: string | null,
    startedAt: number,
    usage: ObservedUsage,
  ): Promise<{
    readonly models: readonly PricedModelUsage[]
    readonly costNano: number
    readonly costState: ReturnType<typeof callCostState>['costState']
  }> {
    const rows = await Promise.all(
      usage.models.map(async (row) => {
        const price =
          runtimeId !== null && row.model !== ''
            ? selectPrice(await deps.prices.line(runtimeId, row.model), startedAt)
            : null
        const cost = modelCost(row, price)
        const state = callCostState([{ tokens: totalTokens(row), cost }]).costState
        return {
          row: { ...row, priceId: price?.id ?? null, costNano: cost.costNano, costState: state },
          cost,
        }
      }),
    )
    const total = callCostState(rows.map(({ row, cost }) => ({ tokens: totalTokens(row), cost })))
    return { models: rows.map(({ row }) => row), ...total }
  }

  async function write(
    callId: string,
    observed: ObservedUsage,
    end?: {
      readonly status: 'done' | 'failed' | 'canceled' | 'interrupted'
      readonly endedAt: number
    },
  ): Promise<void> {
    const context = await deps.store.pricingContext(callId)
    if (!context) return
    const usage = normalizeObservedUsage(observed)
    const { models, costNano, costState } = await priced(
      context.runtimeId,
      context.startedAt,
      usage,
    )
    await deps.store.writeUsage(callId, {
      usageState: usageStateOf(usage, end !== undefined),
      totals: sumBuckets(usage.models),
      costNano,
      costState,
      models,
      updatedAt: clock(),
      ...(end ? { end } : {}),
    })
  }

  return {
    async accept(call) {
      await deps.store.insert(
        {
          id: call.id,
          purpose: call.purpose,
          taskId: call.taskId,
          nodeRunId: call.nodeRunId,
          systemKind: call.systemKind ?? null,
          systemLabel: call.systemLabel ?? null,
          ownerUserId: call.ownerUserId ?? null,
          agentId: call.agentId,
          agentName: call.agentName,
          runtimeId: call.runtimeId,
          runtimeName: call.runtimeName,
          protocol: call.protocol,
          startedAt: call.startedAt,
        },
        clock(),
      )
    },
    usage(callId, usage) {
      return enqueue(callId, () => write(callId, usage))
    },
    finish(callId, outcome) {
      const end = { status: outcome.status, endedAt: outcome.endedAt }
      return enqueue(callId, () =>
        outcome.usage ? write(callId, outcome.usage, end) : deps.store.end(callId, end, clock()),
      )
    },
    async repairInterrupted(bootAt) {
      return await deps.store.interruptRunning(bootAt, clock())
    },
  }
}
