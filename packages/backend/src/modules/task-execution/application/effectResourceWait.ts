import { TaskExecutionError } from './taskExecutionError'

const INITIAL_RESOURCE_WAIT_MS = 10
const MAX_RESOURCE_WAIT_MS = 250

/**
 * A durable resource fence is a correctness boundary, not a user-facing
 * try-lock. Normal sibling contention must wait for the current acting attempt
 * to settle; only stale ownership, an unknown outcome, or another non-resource
 * conflict is surfaced to the caller.
 *
 * The retry re-enters the same owned SQLite transaction, so this also works
 * across daemon processes. Exponential backoff keeps long-running shared
 * workspace/process turns from becoming a hot DB poll.
 */
export async function waitForEffectResourceTurn<T>(acquire: () => T | Promise<T>): Promise<T> {
  let waitMs = INITIAL_RESOURCE_WAIT_MS
  for (;;) {
    try {
      return await acquire()
    } catch (error) {
      if (
        !(error instanceof TaskExecutionError) ||
        error.code !== 'task-execution-resource-conflict'
      ) {
        throw error
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitMs)
    })
    waitMs = Math.min(waitMs * 2, MAX_RESOURCE_WAIT_MS)
  }
}
