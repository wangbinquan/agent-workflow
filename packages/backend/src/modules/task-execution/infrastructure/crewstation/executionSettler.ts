// RFC-370 §9.2 V1 — settle hosted executions that no node will adopt.
//
// Boot recovery never waits for a remote result. A node run that still
// expects its execution is put back to `pending` with its original id and
// the scheduler adopts it. Everything else is settled here, in the
// background, one binding at a time:
// - bindings of a node run that already ended (task cancelled before
//   adoption, a crash between projection and settlement): a missing result is
//   cancelled, since no run consumes it any more;
// - bindings restored from a database snapshot (§9.2 V5) — always stopped;
// - executions owned by no node (system agents, runtime smoke) whose
//   process ended; an owner that comes back reads the stored result;
// - executions owned by no node that their owner cancelled in this epoch.
// A detached observation (shutdown) or an unobservable outcome only affects
// the binding at hand; the next pass retries what is still unsettled.
import { tablesOf } from '@/platform/persistence/sessionTables'
import { inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { Logger } from '@/util/log'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  HostedExecutionDetachedError,
  HostedExecutionUnknownError,
  nullHostedExecutionSink,
  type HostedExecution,
} from './execution'
import type { HostedExecutionBinding, HostedExecutionStore } from './executionStore'

const ADOPTABLE_RUN_STATES = new Set(['pending', 'running'])
const SETTLEMENT_CONCURRENCY = 8

export interface HostedExecutionSettler {
  /** One reconciliation pass; resolves when every settlement it started ended. */
  pass(signal: AbortSignal): Promise<void>
  /** Passes until the signal stops; failures of a pass are logged. */
  run(signal: AbortSignal): Promise<void>
}

export function createHostedExecutionSettler(input: {
  readonly db: PersistenceDb
  readonly store: HostedExecutionStore
  readonly executions: HostedExecution
  readonly fence: CrewStationMutationFence
  readonly log: Pick<Logger, 'info' | 'warn'>
  readonly intervalMs?: number
}): HostedExecutionSettler {
  const settleOne = async (
    { binding, cancel }: { binding: HostedExecutionBinding; cancel: boolean },
    signal: AbortSignal,
  ) => {
    // The observation sends the (idempotent) platform cancel itself.
    if (cancel && binding.result === null && !binding.cancelRequested)
      await input.store.requestCancel(binding.executionId, 'user')
    const adopted = await input.executions.adopt(
      binding.executionId,
      nullHostedExecutionSink(),
      signal,
    )
    await adopted.settle()
  }
  const candidates = async (): Promise<
    readonly { binding: HostedExecutionBinding; cancel: boolean }[]
  > => {
    const bindings = (await input.store.unsettled()).filter(
      (binding) => !input.executions.observing(binding.executionId),
    )
    const runIds = bindings.flatMap((binding) =>
      binding.nodeRunId === undefined ? [] : [binding.nodeRunId],
    )
    const { nodeRuns } = tablesOf(input.db)
    const states = new Map(
      runIds.length === 0
        ? []
        : (
            await input.db
              .select({ id: nodeRuns.id, status: nodeRuns.status })
              .from(nodeRuns)
              .where(inArray(nodeRuns.id, runIds))
          ).map((row) => [row.id, row.status] as const),
    )
    const epoch = input.fence.current().epoch
    return bindings.flatMap((binding) => {
      if (binding.cancelReason === 'restored') return [{ binding, cancel: true }]
      // An owner of this process is between preparing and observing its own
      // execution; only an earlier owner's executions are orphans. Their
      // owner may come back for the stored result, so they are not cancelled.
      // A cancel recorded in this epoch with nobody observing is an orphan too:
      // its owner gave up (a system agent that never got capacity) and will not
      // consume it. Waiting for the next epoch kept its volume in use and its
      // parent running (RFC-370 hosted acceptance, 2026-10-19).
      if (binding.nodeRunId === undefined)
        return binding.epoch < epoch || binding.cancelRequested
          ? [{ binding, cancel: binding.cancelRequested }]
          : []
      const status = states.get(binding.nodeRunId)
      // A pending/running run adopts its own execution through the scheduler.
      if (status !== undefined && ADOPTABLE_RUN_STATES.has(status)) return []
      return [{ binding, cancel: true }]
    })
  }
  let inFlight = 0
  const settleTracked = async (
    candidate: { binding: HostedExecutionBinding; cancel: boolean },
    signal: AbortSignal,
  ) => {
    inFlight += 1
    try {
      await settleOne(candidate, signal)
    } catch (error) {
      if (error instanceof HostedExecutionDetachedError) return
      if (error instanceof HostedExecutionUnknownError) {
        // The binding is already settled with a synthetic unknown result.
        input.log.info('hosted execution settled with an unknown outcome', {
          executionId: candidate.binding.executionId,
          reason: error.message,
        })
        return
      }
      input.log.warn('hosted execution settlement deferred', {
        executionId: candidate.binding.executionId,
        reason: error instanceof Error ? error.message : String(error),
      })
    } finally {
      inFlight -= 1
    }
  }
  /** Starts at most the free share of the global concurrency; executions
   * this process already observes are never picked twice. */
  const pass = async (signal: AbortSignal) => {
    if (signal.aborted) return
    const free = Math.max(0, SETTLEMENT_CONCURRENCY - inFlight)
    const started = (await candidates())
      .slice(0, free)
      .map((candidate) => settleTracked(candidate, signal))
    await Promise.all(started)
  }
  return {
    pass,
    async run(signal) {
      const interval = input.intervalMs ?? 60_000
      while (!signal.aborted) {
        // A long remote result does not hold back the next pass: each pass
        // only starts settlements, bounded by the global concurrency.
        pass(signal).catch((error: unknown) => {
          input.log.warn('hosted execution settlement pass failed', {
            reason: error instanceof Error ? error.message : String(error),
          })
        })
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, interval)
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true },
          )
        })
      }
    },
  }
}
