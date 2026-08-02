// RFC-247 §4.2 T17 — `watch_task`.
//
// A model that launches a task has nothing useful to do until it finishes.
// Polling `get_task` in a loop works but costs a turn each time and teaches the
// model to poll; blocking in one call is both cheaper and what the MCP progress
// protocol is for.
//
// Three constraints shape it:
//
//   · **240s cap.** Long enough to cover most runs, short enough to stay inside
//     the timeouts every HTTP intermediary has an opinion about.
//   · **≤10s heartbeat.** opencode's MCP client sets `resetTimeoutOnProgress`,
//     so a progress notification refreshes ITS timeout too — a heartbeat well
//     inside the client's 30s default keeps a legitimately slow task from being
//     killed by the client while it is still being watched (docs/dev-gotchas.md).
//   · **A timeout is not an error (F8).** Returning `stillRunning: true` with
//     the latest snapshot lets the model decide whether to wait again; an error
//     would tell it something went wrong when nothing did.

import type { McpToolContext } from '@/mcp/tools'

/** Hard cap on one watch call. */
export const WATCH_MAX_MS = 240_000
/** Upper bound between heartbeats. */
export const WATCH_HEARTBEAT_MS = 10_000
/** How often the task is re-read. */
export const WATCH_POLL_MS = 2_000

/**
 * Statuses that mean "stop watching".
 *
 * `awaiting_review` and `awaiting_human` are in here deliberately. They are not
 * finished, but they are exactly the moment a watching model needs to hear
 * about: the run has stopped and will not move again until someone answers.
 * Treating them as "still running" would block for the full 240s while the
 * thing the caller could resolve sits waiting.
 */
const SETTLED = new Set([
  'done',
  'failed',
  'canceled',
  'interrupted',
  'awaiting_review',
  'awaiting_human',
])

export interface WatchDeps {
  /** Injected so tests can drive a fake clock instead of waiting 240 seconds. */
  readonly now: () => number
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

const REAL: WatchDeps = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }),
}

export interface WatchResult {
  readonly task: unknown
  readonly stillRunning: boolean
  readonly waitedMs: number
}

export async function watchTask(
  taskId: string,
  ctx: McpToolContext,
  deps: WatchDeps = REAL,
): Promise<WatchResult> {
  const started = deps.now()
  let lastBeat = started
  let task: unknown = null

  for (;;) {
    const res = await ctx.dispatch({ method: 'GET', path: `/api/tasks/${taskId}` })
    if (res.status >= 400) {
      // A read failure is a real error — unlike a timeout, waiting longer will
      // not help. Let it propagate so the tool reports the code.
      const body = res.body as { code?: string; message?: string } | null
      throw new Error(body?.message ?? `could not read task ${taskId}`)
    }
    task = res.body
    const status = (task as { status?: string } | null)?.status
    if (status !== undefined && SETTLED.has(status)) {
      return { task, stillRunning: false, waitedMs: deps.now() - started }
    }

    const elapsed = deps.now() - started
    if (elapsed >= WATCH_MAX_MS) {
      return { task, stillRunning: true, waitedMs: elapsed }
    }

    if (deps.now() - lastBeat >= WATCH_HEARTBEAT_MS) {
      lastBeat = deps.now()
      // Progress carries the status so a heartbeat is informative rather than
      // just proof of life.
      await ctx.progress(
        `task ${taskId} is ${status ?? 'running'} (${Math.round(elapsed / 1000)}s)`,
      )
    }

    // Never sleep past the cap — otherwise a 2s poll on a 239s-old watch would
    // return at 241s and the "≤240s" promise would be approximate.
    const remaining = WATCH_MAX_MS - (deps.now() - started)
    await deps.sleep(Math.min(WATCH_POLL_MS, Math.max(remaining, 0)), ctx.signal)
  }
}
