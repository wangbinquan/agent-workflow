// RFC-370 §9.2 V1 — one hosted agent / script execution, observed until its
// platform result.
//
// Interruptions are decided here, never by the transport:
// - a daemon shutdown or a lost execution authority DETACHES: the remote
//   subtask keeps running, the binding stays unsettled and the next authority
//   holder adopts it from the durable cursor;
// - a user cancel or the node deadline sends one platform cancel and keeps
//   observing until the platform reports the result;
// - transient platform failures (5xx, 429, transport) only delay the
//   observation; expired history or a rejected request ends it with an
//   explicit unknown outcome and settles the binding so it never blocks a volume.
import { DAEMON_SHUTDOWN_ABORT_REASON } from '@agent-workflow/shared'
import { DomainError } from '@/util/errors'
import {
  isParentNotRunningError,
  type BusinessEvent,
  type BusinessResult,
  type BusinessSubtask,
  type CrewStationBusinessExecution,
} from '@/platform/crewstation/businessExecution'
import { isCrewStationApiError } from '@/platform/crewstation/platformApi'
import type { CrewStationMutationFence } from '@/platform/crewstation/mutationFence'
import {
  isTransientObservationError,
  observeSubtask,
  SubtaskObservationError,
} from '@/platform/crewstation/subtaskStream'
import type {
  HostedCancelReason,
  HostedExecutionBinding,
  HostedExecutionIntent,
  HostedExecutionStore,
} from './executionStore'

/** This caller cannot observe a usable outcome: the binding is settled with a
 * synthetic non-success result, or (refused receipt) cancelled and left to
 * background settlement. Never a success. */
export class HostedExecutionUnknownError extends Error {
  constructor(
    readonly executionId: string,
    reason: string,
  ) {
    super(`hosted execution ${executionId} requires reconciliation: ${reason}`)
    this.name = 'HostedExecutionUnknownError'
  }
}

/** The observer stopped for a daemon shutdown or an execution-authority loss.
 * The remote execution continues; its binding is adopted by the next owner. */
export class HostedExecutionDetachedError extends Error {
  constructor(readonly executionId: string) {
    super(`hosted execution ${executionId} detached for the next execution owner`)
    this.name = 'HostedExecutionDetachedError'
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
  readonly cancelled: boolean
  /** The caller commits its business projection before settling this binding. */
  settle(): Promise<void>
}

export interface HostedExecution {
  find(executionId: string): Promise<HostedExecutionBinding | null>
  /** No unsettled execution of this volume runs at or below `path`. */
  workspaceSettled(taskId: string, path: string): Promise<boolean>
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
  /** Cancel an execution that may have no live observer in this process. */
  cancel(executionId: string, reason?: HostedCancelReason): Promise<void>
  /** Whether this process currently observes the execution. */
  observing(executionId: string): boolean
}

/** After a detach, the run reports its interruption only once the daemon
 * stops (a lost execution authority ends in a shutdown), so its persisted
 * state is `interrupted` and adoptable, never a user cancellation. A user
 * cancel returns at once. */
export async function untilDaemonShutdown(
  signal: AbortSignal | undefined,
  limitMs = 60_000,
): Promise<void> {
  if (signal === undefined || signal.aborted) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, limitMs)
    function done(): void {
      clearTimeout(timer)
      signal!.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

const NULL_SINK: HostedExecutionSink = {
  started: async () => undefined,
  event: async () => undefined,
  checkpoint: async () => undefined,
}

export function nullHostedExecutionSink(): HostedExecutionSink {
  return NULL_SINK
}

function authorityHeld(fence: CrewStationMutationFence): boolean {
  try {
    fence.current()
    return true
  } catch {
    return false
  }
}

/** A write rejected because a successor holds the execution lease. */
function leaseLost(error: unknown): boolean {
  return error instanceof DomainError && error.code === 'execution-standby'
}

const backoff = (failures: number) => Math.min(1_000 * 2 ** Math.min(failures, 5), 30_000)
/** A parent paused again right after each resume is a platform problem. */
const MAX_PARENT_RESUMES = 3

export function createHostedExecution(input: {
  readonly api: CrewStationBusinessExecution
  readonly store: HostedExecutionStore
  readonly fence: CrewStationMutationFence
  /** Resolve without provisioning: inherited logical tasks may share the
   * same physical parent and must participate in the same writer barrier. */
  readonly workspaceTaskId: (taskId: string) => Promise<string | null>
  /** Makes the task's parent ready again (resumes a paused one, §9.2 V3). */
  readonly readyWorkspace?: (taskId: string) => Promise<unknown>
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}): HostedExecution {
  const now = input.now ?? Date.now
  const observers = new Set<string>()
  const wakeups = new Map<string, AbortController>()

  const sleep = input.sleep ?? ((ms: number) => Bun.sleep(ms))
  const sendCancel = async (binding: HostedExecutionBinding): Promise<void> => {
    if (binding.subtaskId === null || binding.attempt === null || binding.result !== null) return
    await input.api.cancelSubtask(binding.businessTaskId, binding.subtaskId, {
      requestKey: `${binding.requestKey}:cancel`,
      expectedAttempt: binding.attempt,
      fence: input.fence.current(),
    })
  }
  /** A refused cancel (4xx: already finished, retried or gone) is left to the
   * observation, which reports the platform's actual outcome; transient
   * failures are retried until the cancel is accepted or this owner stops. */
  const sendCancelUntilAccepted = async (
    binding: HostedExecutionBinding,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    for (let failures = 0; ; failures += 1) {
      try {
        await sendCancel(binding)
        return
      } catch (error) {
        if (!isTransientObservationError(error)) return
        if (signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON || !authorityHeld(input.fence))
          throw new HostedExecutionDetachedError(binding.executionId)
        await sleep(backoff(failures), new AbortController().signal)
      }
    }
  }

  /** The requestKey makes every resubmission a lookup of the original
   * subtask, so a lost receipt is retried rather than reported unknown. */
  const submit = async (
    binding: HostedExecutionBinding,
    signal: AbortSignal | undefined,
  ): Promise<HostedExecutionBinding> => {
    let resumed = 0
    for (let failures = 0; ; failures += 1) {
      if (signal?.aborted && signal.reason !== DAEMON_SHUTDOWN_ABORT_REASON) {
        // The submission may or may not have reached the platform; the
        // settler resubmits with the same requestKey and cancels it.
        await input.store.requestCancel(binding.executionId, 'user').catch(() => undefined)
        throw new HostedExecutionDetachedError(binding.executionId)
      }
      if (signal?.aborted || !authorityHeld(input.fence))
        throw new HostedExecutionDetachedError(binding.executionId)
      let receipt: BusinessSubtask
      try {
        receipt = await input.api.submitSubtask(binding.businessTaskId, {
          ...binding.request,
          requestKey: binding.requestKey,
          fence: input.fence.current(),
        })
      } catch (error) {
        if (!authorityHeld(input.fence)) throw new HostedExecutionDetachedError(binding.executionId)
        // Paused between the readiness check and this submit: resume and
        // repeat the same idempotent request.
        if (
          isParentNotRunningError(error) &&
          input.readyWorkspace !== undefined &&
          resumed < MAX_PARENT_RESUMES
        ) {
          resumed += 1
          await input.readyWorkspace(binding.taskId)
          continue
        }
        if (isCrewStationApiError(error) && !isTransientObservationError(error)) {
          const reason = `submission rejected: ${error.message}`
          await input.store.abandon(binding.executionId, reason)
          throw new HostedExecutionUnknownError(binding.executionId, reason)
        }
        await sleep(backoff(failures), signal ?? new AbortController().signal)
        continue
      }
      return input.store.accepted(binding.executionId, receipt)
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
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const stop = new AbortController()
    const wake = () => stop.abort()
    signal?.addEventListener('abort', wake)
    wakeups.set(executionId, stop)
    try {
      let binding = initial
      if (binding.subtaskId === null) binding = await submit(binding, signal)
      try {
        await sink.started(binding)
      } catch (error) {
        // The caller refused the receipt, so nothing will consume this run:
        // the cancel is recorded first (the settler repeats it if this
        // process stops) and then sent.
        await input.store.requestCancel(executionId, 'user')
        await sendCancel(binding).catch(() => undefined)
        throw new HostedExecutionUnknownError(
          executionId,
          `receipt acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      // Replay the durable prefix: the envelope, usage and output state of
      // the caller are rebuilt exactly; projection source keys make it
      // idempotent. The platform is then read strictly after that prefix.
      let result = binding.result
      let cursor = binding.lastCursor
      for (const event of await input.store.replay(executionId)) {
        await sink.event(event)
        cursor = event.cursor
        if (event.type === 'result') result = event.data
      }
      await sink.checkpoint()
      const deadline =
        binding.timeoutMs === undefined ? null : binding.createdAt + binding.timeoutMs
      let timedOut = binding.cancelReason === 'timeout'
      let cancelSent = false
      if (deadline !== null && result === null) {
        deadlineTimer = setTimeout(
          () => {
            timedOut = true
            wake()
          },
          Math.max(0, deadline - now()),
        )
      }
      while (result === null) {
        const latest = await input.store.get(executionId)
        if (latest === null) throw new Error('hosted-execution-binding-missing')
        const cancelWanted =
          !cancelSent &&
          (timedOut ||
            latest.cancelRequested ||
            (signal?.aborted === true && signal.reason !== DAEMON_SHUTDOWN_ABORT_REASON))
        if (
          signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON &&
          !cancelSent &&
          !latest.cancelRequested
        )
          throw new HostedExecutionDetachedError(executionId)
        if (cancelWanted) {
          await input.store.requestCancel(executionId, timedOut ? 'timeout' : 'user')
          await sendCancelUntilAccepted(latest, signal)
          cancelSent = true
        }
        // Once a cancel was sent the observation waits for the platform
        // result; only a daemon shutdown or authority loss interrupts it.
        const observation = cancelSent ? new AbortController() : stop
        if (cancelSent) {
          // Further cancel requests are no-ops; only a shutdown stops waiting.
          wakeups.delete(executionId)
          if (signal?.reason === DAEMON_SHUTDOWN_ABORT_REASON) observation.abort()
          else
            signal?.addEventListener(
              'abort',
              () => {
                if (signal.reason === DAEMON_SHUTDOWN_ABORT_REASON) observation.abort()
              },
              { once: true },
            )
        }
        let end
        try {
          end = await observeSubtask({
            api: input.api,
            target: {
              businessTaskId: binding.businessTaskId,
              subtaskId: binding.subtaskId!,
              attempt: binding.attempt!,
            },
            after: cursor,
            signal: observation.signal,
            active: () => authorityHeld(input.fence),
            ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
            async onEvent(event) {
              await input.store.record(executionId, event)
              await sink.event(event)
              await sink.checkpoint()
              cursor = event.cursor
            },
          })
        } catch (error) {
          if (leaseLost(error) || !authorityHeld(input.fence))
            throw new HostedExecutionDetachedError(executionId)
          if (error instanceof SubtaskObservationError) {
            await input.store.abandon(executionId, `${error.failure}: ${error.message}`)
            throw new HostedExecutionUnknownError(executionId, `${error.failure}: ${error.message}`)
          }
          throw error
        }
        if (end.kind === 'result') {
          result = end.result
          break
        }
        if (!authorityHeld(input.fence)) throw new HostedExecutionDetachedError(executionId)
        if (cancelSent) throw new HostedExecutionDetachedError(executionId)
      }
      const settled = (await input.store.get(executionId)) ?? binding
      return {
        binding: { ...settled, lastCursor: cursor, result },
        result,
        timedOut: timedOut || settled.cancelReason === 'timeout',
        cancelled: settled.cancelRequested,
        settle: () => input.store.settle(executionId),
      }
    } catch (error) {
      // Any write refused because a successor holds the lease detaches.
      if (
        !(error instanceof HostedExecutionUnknownError) &&
        !(error instanceof HostedExecutionDetachedError) &&
        (leaseLost(error) || !authorityHeld(input.fence))
      )
        throw new HostedExecutionDetachedError(executionId)
      throw error
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      signal?.removeEventListener('abort', wake)
      wakeups.delete(executionId)
      observers.delete(executionId)
    }
  }

  return {
    find: input.store.get,
    observing: (executionId) => observers.has(executionId),
    async workspaceSettled(taskId, path) {
      const businessTaskId = await input.workspaceTaskId(taskId)
      const overlaps = (cwd: string) =>
        cwd === path || cwd.startsWith(path + '/') || path.startsWith(cwd.replace(/\/$/, '') + '/')
      return (await input.store.unsettled()).every(
        (binding) =>
          (binding.taskId !== taskId &&
            (businessTaskId === null || binding.businessTaskId !== businessTaskId)) ||
          !overlaps(binding.request.cwd ?? '/work'),
      )
    },
    async run(intent, sink, signal) {
      return observe(await input.store.prepare(intent), sink, signal)
    },
    async adopt(executionId, sink, signal) {
      const binding = await input.store.get(executionId)
      if (binding === null) throw new Error('hosted-execution-binding-missing')
      return observe(binding, sink ?? NULL_SINK, signal)
    },
    async cancel(executionId, reason = 'user') {
      await input.store.requestCancel(executionId, reason)
      const binding = await input.store.get(executionId)
      // A live observer sends the cancel itself and keeps observing.
      if (observers.has(executionId)) {
        wakeups.get(executionId)?.abort()
        return
      }
      if (binding !== null) await sendCancel(binding)
    },
  }
}
