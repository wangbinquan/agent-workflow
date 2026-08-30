// RFC-247 §4.2 T17 / F8 / F9 — `watch_task` timing behaviour.
//
// Driven on a fake clock: the real thing waits up to four minutes, and a test
// that actually waited would be both slow and unable to assert anything about
// the heartbeat cadence it is supposed to guarantee.
//
// What must hold, and why each one matters:
//
//   · a settled task returns immediately (no reason to sit for 240s)
//   · `awaiting_human` counts as settled — it is precisely the event a watching
//     model needs, and blocking through it wastes the whole budget on a task
//     that will not move until someone answers
//   · hitting the cap is a normal return with `stillRunning: true`, NOT an error
//   · a client that sent no progressToken still gets identical blocking and
//     timeout behaviour — the heartbeat is the only thing that disappears

import { describe, expect, test } from 'bun:test'
import type { McpToolContext } from '../src/mcp/tools'
import { watchTask, WATCH_HEARTBEAT_MS, WATCH_MAX_MS, type WatchDeps } from '../src/mcp/watch'
import {
  forwardingOperationHandles,
  recordingOperationHandles,
} from './helpers/mcpOperationRecording'

interface Rig {
  ctx: McpToolContext
  deps: WatchDeps
  progressMessages: string[]
  reads: number
}

/**
 * @param statuses status returned on each successive read; the last repeats.
 */
function rig(statuses: string[], opts: { withProgress?: boolean } = {}): Rig {
  let clock = 0
  const progressMessages: string[] = []
  const state = { reads: 0 }
  const deps: WatchDeps = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms
    },
  }
  const ctx = {
    actor: {} as McpToolContext['actor'],
    operations: recordingOperationHandles('watch_task', [], () => {
      const status = statuses[Math.min(state.reads, statuses.length - 1)]
      state.reads += 1
      return { id: 't1', status }
    }),
    progress: async (message: string) => {
      if (opts.withProgress === false) return
      progressMessages.push(message)
    },
    signal: new AbortController().signal,
  } as unknown as McpToolContext
  return {
    ctx,
    deps,
    progressMessages,
    get reads() {
      return state.reads
    },
  }
}

describe('RFC-247 watch_task — settled statuses return at once', () => {
  for (const status of ['done', 'failed', 'canceled', 'interrupted']) {
    test(`${status} returns immediately`, async () => {
      const r = rig([status])
      const out = await watchTask('t1', r.ctx, r.deps)
      expect(out.stillRunning).toBe(false)
      expect(out.waitedMs).toBe(0)
      expect((out.task as { status: string }).status).toBe(status)
    })
  }

  test('awaiting_human settles the watch rather than burning the budget', async () => {
    const r = rig(['running', 'awaiting_human'])
    const out = await watchTask('t1', r.ctx, r.deps)
    expect(out.stillRunning).toBe(false)
    expect(out.waitedMs).toBeLessThan(WATCH_MAX_MS)
  })

  test('awaiting_review likewise', async () => {
    const out = await (async () => {
      const r = rig(['awaiting_review'])
      return watchTask('t1', r.ctx, r.deps)
    })()
    expect(out.stillRunning).toBe(false)
  })
})

describe('RFC-247 watch_task — the 240s cap (F8)', () => {
  test('a task that never settles returns stillRunning, not an error', async () => {
    const r = rig(['running'])
    const out = await watchTask('t1', r.ctx, r.deps)
    expect(out.stillRunning).toBe(true)
    expect((out.task as { status: string }).status).toBe('running')
  })

  test('it does not overrun the cap', async () => {
    const r = rig(['running'])
    const out = await watchTask('t1', r.ctx, r.deps)
    expect(out.waitedMs).toBeLessThanOrEqual(WATCH_MAX_MS)
  })

  test('it heartbeats at least every 10s across the whole wait', async () => {
    const r = rig(['running'])
    await watchTask('t1', r.ctx, r.deps)
    // 240s / 10s = 24 heartbeats minimum. Anything less means a client with
    // `resetTimeoutOnProgress` could time the call out while it is healthy.
    expect(r.progressMessages.length).toBeGreaterThanOrEqual(WATCH_MAX_MS / WATCH_HEARTBEAT_MS - 1)
  })

  test('the heartbeat says what the task is doing', async () => {
    const r = rig(['running'])
    await watchTask('t1', r.ctx, r.deps)
    expect(r.progressMessages[0]).toContain('running')
    expect(r.progressMessages[0]).toContain('t1')
  })
})

describe('RFC-247 watch_task — F9: no progressToken changes nothing but the notifications', () => {
  test('blocking and timeout behave identically when progress is a no-op', async () => {
    const withToken = rig(['running'])
    const withoutToken = rig(['running'], { withProgress: false })
    const a = await watchTask('t1', withToken.ctx, withToken.deps)
    const b = await watchTask('t1', withoutToken.ctx, withoutToken.deps)
    expect(b.stillRunning).toBe(a.stillRunning)
    expect(b.waitedMs).toBe(a.waitedMs)
    expect(withoutToken.progressMessages).toEqual([])
    expect(withToken.progressMessages.length).toBeGreaterThan(0)
  })
})

describe('RFC-247 watch_task — a read failure is a real error', () => {
  test('it throws rather than pretending the task is still running', async () => {
    // Waiting longer cannot fix an unreadable task, and reporting
    // `stillRunning` would have the model wait again forever.
    const ctx = {
      operations: forwardingOperationHandles('watch_task', [], () => ({
        status: 404,
        body: { code: 'task-not-found', message: 'gone' },
      })),
      progress: async () => {},
      signal: new AbortController().signal,
    } as unknown as McpToolContext
    await expect(
      watchTask('missing', ctx, { now: () => 0, sleep: async () => {} }),
    ).rejects.toThrow('gone')
  })
})
