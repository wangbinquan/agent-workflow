// RFC-370 §9.2 V1/V2 — the neutral "observe one CrewStation subtask until its
// result" loop shared by task executions and workspace commands.
//
// It owns no persistence and makes no lifecycle decision. The caller durably
// consumes every event (`onEvent` resolves only after the event is projected)
// and decides what an interruption means: a user cancel sends a platform
// cancel and observes again, a daemon shutdown detaches and leaves the remote
// execution to its successor.
import type {
  BusinessEvent,
  BusinessResult,
  CrewStationBusinessExecution,
} from './businessExecution'
import { isCrewStationApiError } from './platformApi'

export interface SubtaskObservationTarget {
  readonly businessTaskId: string
  readonly subtaskId: string
  readonly attempt: number
}

export type SubtaskObservationEnd =
  | { readonly kind: 'result'; readonly result: BusinessResult; readonly cursor: string }
  /** The caller's signal stopped the observation; the subtask is untouched. */
  | { readonly kind: 'stopped' }

export type SubtaskObservationFailure =
  /** 410: the platform no longer retains the history after this cursor. */
  | 'expired'
  /** Any other 4xx: the request itself is not acceptable. */
  | 'rejected'
  /** An event for another subtask/attempt, or a result whose cursor is not its own. */
  | 'identity'

export class SubtaskObservationError extends Error {
  constructor(
    readonly failure: SubtaskObservationFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SubtaskObservationError'
  }
}

const MAX_BACKOFF_MS = 30_000

/** The caller's own consumption failed; it is never retried as a transport
 * failure and surfaces to the caller unchanged. */
class ConsumerFailure {
  constructor(readonly error: unknown) {}
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/** Transport outages and 5xx/429 never end an observation: the remote
 * execution keeps running, so the observer keeps reconnecting from its last
 * durable cursor until the caller's signal stops it. */
export function isTransientObservationError(error: unknown): boolean {
  if (!isCrewStationApiError(error)) return true
  return error.status >= 500 || error.status === 429 || error.status === 408
}

export async function observeSubtask(input: {
  readonly api: Pick<CrewStationBusinessExecution, 'events' | 'streamEvents'>
  readonly target: SubtaskObservationTarget
  /** Exclusive: only events strictly after this cursor are delivered. */
  readonly after: string | null
  readonly signal: AbortSignal
  /** Checked before every platform request; false stops the observation
   * (for example, the execution authority moved to another instance). */
  readonly active?: () => boolean
  readonly onEvent: (event: BusinessEvent) => Promise<void>
  /** Observed transient failure (for status display); never ends observation. */
  readonly onReconnecting?: (error: unknown, attempt: number) => void
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}): Promise<SubtaskObservationEnd> {
  const sleep = input.sleep ?? abortableSleep
  const { businessTaskId, subtaskId, attempt } = input.target
  let cursor = input.after
  let failures = 0
  const consume = async (event: BusinessEvent): Promise<BusinessResult | null> => {
    if (event.cursor === cursor) return null
    if (
      event.taskId !== businessTaskId ||
      event.subtaskId !== subtaskId ||
      event.attempt !== attempt
    )
      throw new SubtaskObservationError('identity', 'platform event identity mismatch')
    if (event.type === 'result' && event.data.finalCursor !== event.cursor)
      throw new SubtaskObservationError('identity', 'result cursor mismatch')
    try {
      await input.onEvent(event)
    } catch (error) {
      throw new ConsumerFailure(error)
    }
    cursor = event.cursor
    return event.type === 'result' ? event.data : null
  }
  const active = input.active ?? (() => true)
  while (!input.signal.aborted && active()) {
    try {
      // Pagination first: a finished subtask ends immediately and expired
      // history surfaces as a 410 before an SSE connection is opened.
      const page = await input.api.events(businessTaskId, {
        ...(cursor === null ? {} : { after: cursor }),
        subtaskId,
      })
      for (const event of page.items) {
        const result = await consume(event)
        if (result !== null) return { kind: 'result', result, cursor: event.cursor }
      }
      failures = 0
      if (page.hasMore) continue
      if (input.signal.aborted) break
      for await (const event of input.api.streamEvents(
        businessTaskId,
        { ...(cursor === null ? {} : { after: cursor }), subtaskId },
        input.signal,
      )) {
        const result = await consume(event)
        if (result !== null) return { kind: 'result', result, cursor: event.cursor }
      }
      // A clean end is the platform's bounded connection lifetime; reconnect.
    } catch (error) {
      if (error instanceof ConsumerFailure) throw error.error
      if (input.signal.aborted) break
      if (error instanceof SubtaskObservationError) throw error
      if (isCrewStationApiError(error) && error.status === 410)
        throw new SubtaskObservationError('expired', error.message, 410)
      if (!isTransientObservationError(error)) {
        const status = isCrewStationApiError(error) ? error.status : undefined
        throw new SubtaskObservationError(
          'rejected',
          error instanceof Error ? error.message : String(error),
          status,
        )
      }
      failures += 1
      input.onReconnecting?.(error, failures)
      await sleep(Math.min(1_000 * 2 ** Math.min(failures - 1, 5), MAX_BACKOFF_MS), input.signal)
    }
  }
  return { kind: 'stopped' }
}
