import type {
  BusinessEvent,
  BusinessResult,
  CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import type {
  HostedExecutionBinding,
  HostedExecutionIntent,
  HostedExecutionStore,
} from './executionStore'

export class HostedExecutionUnknownError extends Error {
  constructor(
    readonly executionId: string,
    reason: string,
  ) {
    super(`hosted execution ${executionId} requires reconciliation: ${reason}`)
    this.name = 'HostedExecutionUnknownError'
  }
}

export interface HostedExecutionSink {
  /** Must durably acknowledge before the first event is projected. */
  started(binding: HostedExecutionBinding): Promise<void>
  event(event: BusinessEvent): Promise<void>
  /** Commit all events delivered so far before advancing the platform cursor. */
  checkpoint(): Promise<void>
}

export interface HostedExecutionResult {
  readonly binding: HostedExecutionBinding
  readonly result: BusinessResult
  readonly timedOut: boolean
  /** The caller commits its business projection before settling this binding. */
  settle(): Promise<void>
}

export interface HostedExecution {
  find(executionId: string): Promise<HostedExecutionBinding | null>
  run(
    intent: HostedExecutionIntent,
    sink: HostedExecutionSink,
    signal?: AbortSignal,
  ): Promise<HostedExecutionResult>
  adopt(
    executionId: string,
    sink: HostedExecutionSink,
    signal?: AbortSignal,
  ): Promise<HostedExecutionResult>
  cancel(executionId: string): Promise<void>
}

/** One service-local observer per execution, with all identities durable. A
 * lost HTTP response is resolved by repeating the frozen requestKey. Only a
 * platform result settles an execution; stream loss and process=unknown do not. */
export function createHostedExecution(input: {
  readonly api: CrewStationBusinessExecution
  readonly store: HostedExecutionStore
  readonly fence: CrewStationMutationFence
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
}): HostedExecution {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms) => Bun.sleep(ms))
  const observers = new Set<string>()
  const wakeups = new Map<string, AbortController>()
  const cancel = async (executionId: string): Promise<void> => {
    await input.store.requestCancel(executionId)
    wakeups.get(executionId)?.abort()
    const binding = await input.store.get(executionId)
    if (binding?.subtaskId != null && binding.attempt !== null && binding.result === null) {
      await input.api.cancelSubtask(binding.businessTaskId, binding.subtaskId, {
        requestKey: `${binding.requestKey}:cancel`,
        expectedAttempt: binding.attempt,
        fence: input.fence.current(),
      })
    }
  }
  const observe = async (
    initial: HostedExecutionBinding,
    sink: HostedExecutionSink,
    signal?: AbortSignal,
  ): Promise<HostedExecutionResult> => {
    const executionId = initial.executionId
    if (observers.has(executionId)) throw new Error('hosted-execution-observer-already-running')
    observers.add(executionId)
    let binding = initial
    let timedOut = initial.cancelReason === 'timeout'
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const wake = () => wakeups.get(executionId)?.abort()
    signal?.addEventListener('abort', wake)
    try {
      if (binding.subtaskId === null) {
        try {
          const receipt = await input.api.submitSubtask(binding.businessTaskId, {
            ...binding.request,
            requestKey: binding.requestKey,
            fence: input.fence.current(),
          })
          binding = await input.store.accepted(executionId, receipt)
        } catch (error) {
          throw new HostedExecutionUnknownError(
            executionId,
            `submission not confirmed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
      if (binding.subtaskId === null || binding.attempt === null) {
        throw new Error('hosted-execution-receipt-missing')
      }
      try {
        await sink.started(binding)
      } catch (error) {
        throw new HostedExecutionUnknownError(
          executionId,
          `receipt acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      let result = binding.result
      let cursor = binding.lastCursor
      // Replay the durable prefix to reconstruct the envelope, usage and
      // command result. Projection source keys make replay idempotent. Reading
      // the platform resumes strictly after its last committed cursor.
      const replay = await input.store.replay(executionId)
      try {
        for (const event of replay) {
          await sink.event(event)
          if (event.type === 'result') {
            if (event.data.finalCursor !== event.cursor)
              throw new HostedExecutionUnknownError(executionId, 'result cursor mismatch')
            result = event.data
          }
        }
        await sink.checkpoint()
      } catch (error) {
        if (error instanceof HostedExecutionUnknownError) throw error
        throw new HostedExecutionUnknownError(
          executionId,
          `replay projection failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const lastReplayed = replay.at(-1)
      if (lastReplayed !== undefined) {
        cursor = lastReplayed.cursor
        await input.store.checkpoint(executionId, cursor, result ?? undefined)
      }
      const deadline =
        binding.timeoutMs === undefined ? null : binding.createdAt + binding.timeoutMs
      if (deadline !== null) deadlineTimer = setTimeout(wake, Math.max(0, deadline - now()))
      let cancelSent = false
      let reconnectFailures = 0
      const consume = async (event: BusinessEvent): Promise<void> => {
        if (event.type === 'gap')
          throw new HostedExecutionUnknownError(executionId, event.data.reason)
        if (
          event.taskId !== binding.businessTaskId ||
          event.subtaskId !== binding.subtaskId ||
          event.attempt !== binding.attempt
        ) {
          throw new HostedExecutionUnknownError(executionId, 'platform event identity mismatch')
        }
        if (event.cursor === cursor) return
        await input.store.journal(executionId, event)
        try {
          await sink.event(event)
          await sink.checkpoint()
        } catch (error) {
          throw new HostedExecutionUnknownError(
            executionId,
            `projection failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // The result is durable only after every earlier event has been
        // consumed, and its finalCursor must be this event's own position.
        if (event.type === 'result') {
          if (event.data.finalCursor !== event.cursor) {
            throw new HostedExecutionUnknownError(executionId, 'result cursor mismatch')
          }
          result = event.data
        }
        await input.store.checkpoint(executionId, event.cursor, result ?? undefined)
        cursor = event.cursor
      }
      while (result === null) {
        input.fence.current()
        const latest = await input.store.get(executionId)
        if (latest === null) throw new Error('hosted-execution-binding-missing')
        timedOut =
          latest.cancelReason === 'timeout' ||
          (latest.cancelReason === null && deadline !== null && now() >= deadline)
        if ((signal?.aborted || timedOut || latest.cancelRequested) && !cancelSent) {
          await input.store.requestCancel(executionId, timedOut ? 'timeout' : 'user')
          await input.api.cancelSubtask(binding.businessTaskId, binding.subtaskId, {
            requestKey: `${binding.requestKey}:cancel`,
            expectedAttempt: binding.attempt,
            fence: input.fence.current(),
          })
          cancelSent = true
        }
        const connection = new AbortController()
        wakeups.set(executionId, connection)
        try {
          // Pagination first catches a terminal event immediately and provides
          // explicit retention errors. SSE then waits without busy polling.
          const page = await input.api.events(binding.businessTaskId, {
            ...(cursor === null ? {} : { after: cursor }),
            subtaskId: binding.subtaskId,
          })
          for (const event of page.items) await consume(event)
          if (result !== null) break
          if (page.hasMore) continue
          if (!cancelSent && (signal?.aborted || (deadline !== null && now() >= deadline))) continue
          for await (const event of input.api.streamEvents(
            binding.businessTaskId,
            {
              ...(cursor === null ? {} : { after: cursor }),
              subtaskId: binding.subtaskId,
            },
            connection.signal,
          )) {
            await consume(event)
            if (result !== null) break
          }
          reconnectFailures = 0
        } catch (error) {
          if (connection.signal.aborted) continue
          if (error instanceof HostedExecutionUnknownError) throw error
          if (isCrewStationApiError(error) && error.status < 500 && error.status !== 429) {
            throw new HostedExecutionUnknownError(executionId, `${error.status}: ${error.message}`)
          }
          // A bounded transport outage leaves the execution running and its
          // binding unsettled; recovery can attach again with the same cursor.
          reconnectFailures += 1
          if (reconnectFailures >= 5) {
            throw new HostedExecutionUnknownError(
              executionId,
              error instanceof Error ? error.message : String(error),
            )
          }
          await sleep(Math.min(1_000 * 2 ** (reconnectFailures - 1), 10_000))
        } finally {
          wakeups.delete(executionId)
        }
      }
      return {
        binding: { ...binding, lastCursor: cursor, result },
        result,
        timedOut,
        settle: () => input.store.settle(executionId),
      }
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      signal?.removeEventListener('abort', wake)
      wakeups.delete(executionId)
      observers.delete(executionId)
    }
  }
  return {
    find: input.store.get,
    async run(intent, sink, signal) {
      return observe(await input.store.prepare(intent), sink, signal)
    },
    async adopt(executionId, sink, signal) {
      const binding = await input.store.get(executionId)
      if (binding === null) throw new Error('hosted-execution-binding-missing')
      return observe(binding, sink, signal)
    },
    cancel,
  }
}
