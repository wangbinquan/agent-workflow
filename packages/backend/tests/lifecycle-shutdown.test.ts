// RFC-053 — shutdown contract for the two background tickers.
//
// `startLifecycleInvariantsLoop` (boot timeout + 1h interval) and
// `startStuckTaskDetectorLoop` (5 min interval) both return a `.stop()`
// handle that the daemon `cli/start.ts` shutdown path calls. A
// regression there (e.g. someone removes one of the stop() calls) would
// leak a setInterval into the next test run / process exit.
//
// We can't easily assert "no leaked timer" at the OS level, but we *can*
// drive the timers forward via fake timers + assert that runs do NOT
// fire after stop(). This locks the cleanup contract.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { startLifecycleInvariantsLoop } from '../src/services/lifecycleInvariants'
import { startStuckTaskDetectorLoop } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function freshDb(): { db: DbClient; cleanup: () => void } {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-shutdown-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return { db, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function seedRunningTask(db: DbClient): Promise<void> {
  const wfId = 'wf-shutdown'
  const tId = 't-shutdown'
  await db.insert(workflows).values({
    id: wfId,
    name: 'w',
    definition: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
  })
  await db.insert(tasks).values({
    id: tId,
    name: 't',
    workflowId: wfId,
    workflowSnapshot: '{"$schema_version":2,"inputs":[],"nodes":[],"edges":[]}',
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${tId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

describe('RFC-053 — startLifecycleInvariantsLoop.stop()', () => {
  let cleanup: () => void
  beforeEach(() => {
    cleanup = () => {}
  })
  afterEach(() => cleanup())

  test('returns a handle whose stop() clears both bootTimer + periodicTimer', async () => {
    const env = freshDb()
    cleanup = env.cleanup
    await seedRunningTask(env.db)
    let scans = 0
    const orig = setInterval
    const intervals: ReturnType<typeof setInterval>[] = []
    // Patch setInterval / setTimeout to count handles that get cleared.
    const setIntervalSpy = ((cb: (...a: unknown[]) => void, ms: number) => {
      const h = orig(cb, ms)
      intervals.push(h)
      return h
    }) as typeof setInterval
    const origClear = clearInterval
    let cleared = 0
    const clearIntervalSpy = ((h: NodeJS.Timeout) => {
      cleared++
      return origClear(h)
    }) as typeof clearInterval
    const origSetTimeout = setTimeout
    const timeouts: ReturnType<typeof setTimeout>[] = []
    const setTimeoutSpy = ((cb: (...a: unknown[]) => void, ms: number) => {
      const h = origSetTimeout(cb, ms)
      timeouts.push(h)
      return h
    }) as typeof setTimeout
    const origClearTimeout = clearTimeout
    let timeoutsCleared = 0
    const clearTimeoutSpy = ((h: NodeJS.Timeout) => {
      timeoutsCleared++
      return origClearTimeout(h)
    }) as typeof clearTimeout

    // Patch globals.
    globalThis.setInterval = setIntervalSpy
    globalThis.clearInterval = clearIntervalSpy
    globalThis.setTimeout = setTimeoutSpy
    globalThis.clearTimeout = clearTimeoutSpy
    try {
      // Use absurdly large intervals so they never fire during the test.
      const ticker = startLifecycleInvariantsLoop({
        db: env.db,
        bootDelayMs: 60_000,
        intervalMs: 60_000,
        onAlert: () => {
          scans++
        },
      })
      // RFC-322 起，周期拍先经过一个相位 setTimeout 才装 setInterval，所以构造完成的
      // 瞬间是「boot setTimeout + 相位 setTimeout + 0 个 setInterval」，而不是原来的
      // 「1 个 setTimeout + 1 个 setInterval」。本用例守的是 stop() 的完备性，不是
      // 定时器种类，所以断言改成**注册了几个就必须清掉几个**（比原来的 >=1 更强）。
      const registered = intervals.length + timeouts.length
      expect(registered).toBeGreaterThanOrEqual(2)
      ticker.stop()
      // 每一个注册过的 timer 都被清掉，一个不漏。
      expect(cleared + timeoutsCleared).toBeGreaterThanOrEqual(registered)
      // After stop(), no scan should have run (timers were huge and we just cleared them).
      expect(scans).toBe(0)
    } finally {
      globalThis.setInterval = orig
      globalThis.clearInterval = origClear
      globalThis.setTimeout = origSetTimeout
      globalThis.clearTimeout = origClearTimeout
    }
  })

  test('stop() can be called multiple times without throwing', async () => {
    const env = freshDb()
    cleanup = env.cleanup
    await seedRunningTask(env.db)
    const ticker = startLifecycleInvariantsLoop({
      db: env.db,
      bootDelayMs: 60_000,
      intervalMs: 60_000,
    })
    ticker.stop()
    expect(() => ticker.stop()).not.toThrow()
  })
})

describe('RFC-053 — startStuckTaskDetectorLoop.stop()', () => {
  let cleanup: () => void
  beforeEach(() => {
    cleanup = () => {}
  })
  afterEach(() => cleanup())

  test('returns a handle whose stop() clears the setInterval', async () => {
    const env = freshDb()
    cleanup = env.cleanup
    await seedRunningTask(env.db)
    const orig = setInterval
    const origClear = clearInterval
    let cleared = 0
    globalThis.clearInterval = ((h: NodeJS.Timeout) => {
      cleared++
      return origClear(h)
    }) as typeof clearInterval
    try {
      const ticker = startStuckTaskDetectorLoop({ db: env.db, intervalMs: 60_000 })
      ticker.stop()
      expect(cleared).toBeGreaterThanOrEqual(1)
    } finally {
      globalThis.setInterval = orig
      globalThis.clearInterval = origClear
    }
  })

  test('idempotent stop()', async () => {
    const env = freshDb()
    cleanup = env.cleanup
    await seedRunningTask(env.db)
    const ticker = startStuckTaskDetectorLoop({ db: env.db, intervalMs: 60_000 })
    ticker.stop()
    expect(() => ticker.stop()).not.toThrow()
  })
})
