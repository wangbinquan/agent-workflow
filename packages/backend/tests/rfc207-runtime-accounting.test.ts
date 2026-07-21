// RFC-207 §3.8 — run-time accounting through the ACTUAL status transitions.
//
// design/test-guard-audit-2026-07-21 gap B2-lifecycle-3 (Top-11): the
// `runningMs` / `runningSince` accounting is computed inside setTaskStatus, but
// the only tests that touched those columns SEEDED them directly and never
// drove a real transition. So getting the accounting wrong either way stayed
// green:
//   - forget to accumulate on leaving `running` → maxDurationMs never fires,
//     a runaway task burns tokens forever;
//   - forget to clear `runningSince` on parking → time spent in awaiting_human
//     counts against the limit and the task is killed the instant the human
//     answers (exactly what RFC-207 §3.8 exists to prevent).
//
// These drive real transitions with an INJECTED clock (setTaskStatus now takes
// `now`) so the arithmetic is deterministic, and pair the accounting with the
// limits reader to prove the end-to-end behaviour.

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { setTaskStatus } from '../src/services/lifecycle'
import { enforceLimits } from '../src/services/limits'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

let db: DbClient
let workflowId: string

beforeEach(async () => {
  db = createInMemoryDb(MIGRATIONS)
  workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify({ $schema_version: 3, inputs: [], nodes: [], edges: [] }),
  })
})

async function seed(
  status: string,
  extra: Partial<typeof tasks.$inferInsert> = {},
): Promise<string> {
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc207',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: status as never,
    inputs: '{}',
    startedAt: 0,
    ...extra,
  })
  return taskId
}

async function acct(taskId: string): Promise<{ runningMs: number; runningSince: number | null }> {
  const row = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
  return { runningMs: row.runningMs, runningSince: row.runningSince }
}

const T0 = 1_000_000

describe('RFC-207 run-time accounting through real transitions', () => {
  test('entering running opens a stretch (runningSince set, runningMs untouched)', async () => {
    const id = await seed('pending')
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['pending'],
      reason: 't',
      now: T0,
    })
    expect(await acct(id)).toEqual({ runningMs: 0, runningSince: T0 })
  })

  test('parking (running → awaiting_human) closes the stretch and clears runningSince', async () => {
    const id = await seed('pending')
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['pending'],
      reason: 't',
      now: T0,
    })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'awaiting_human',
      allowedFrom: ['running'],
      reason: 'park',
      now: T0 + 5_000,
    })
    // 5s of running accumulated; the clock is now stopped.
    expect(await acct(id)).toEqual({ runningMs: 5_000, runningSince: null })
  })

  test('parked time does NOT accrue, and unparking reopens the clock without double-counting', async () => {
    const id = await seed('pending')
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['pending'],
      reason: 't',
      now: T0,
    })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'awaiting_human',
      allowedFrom: ['running'],
      reason: 'park',
      now: T0 + 5_000,
    })
    // Human takes a long time (1 hour parked) — this must NOT accrue.
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['awaiting_human'],
      reason: 'unpark',
      now: T0 + 3_605_000,
    })
    // runningMs unchanged by the park; a fresh stretch is open.
    expect(await acct(id)).toEqual({ runningMs: 5_000, runningSince: T0 + 3_605_000 })
  })

  test('multiple running stretches sum; final done adds the last stretch', async () => {
    const id = await seed('pending')
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['pending'],
      reason: 't',
      now: T0,
    })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'awaiting_human',
      allowedFrom: ['running'],
      reason: 'park',
      now: T0 + 4_000,
    })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['awaiting_human'],
      reason: 'unpark',
      now: T0 + 100_000,
    })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'done',
      allowedFrom: ['running'],
      allowTerminal: true,
      reason: 'finish',
      now: T0 + 100_000 + 6_000,
    })
    // 4s + 6s of running; the 96s parked between them does not count.
    expect((await acct(id)).runningMs).toBe(10_000)
  })

  test('a transition NOT involving running leaves the accounting untouched', async () => {
    const id = await seed('pending', { runningMs: 1234, runningSince: null })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'canceled',
      allowedFrom: ['pending'],
      allowTerminal: true,
      reason: 'cancel',
      now: T0,
    })
    expect(await acct(id)).toEqual({ runningMs: 1234, runningSince: null })
  })

  test('COALESCE fallback: leaving running with a null runningSince adds zero, not NaN/negative', async () => {
    // Defensive: a crash-recovered row can be `running` with runningSince null.
    const id = await seed('running', { runningMs: 500, runningSince: null })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'failed',
      allowedFrom: ['running'],
      allowTerminal: true,
      reason: 'fail',
      now: T0,
    })
    expect(await acct(id)).toEqual({ runningMs: 500, runningSince: null })
  })
})

describe('RFC-207 accounting drives the limit (end-to-end)', () => {
  test('accumulated running time over maxDurationMs makes enforceLimits cancel', async () => {
    const id = await seed('pending', { maxDurationMs: 10_000 })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['pending'],
      reason: 't',
      now: T0,
    })
    // 12s of running elapsed (> the 10s cap).
    const r = await enforceLimits(db, T0 + 12_000)
    expect(r.canceled).toContain(id)
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0]!.status).toBe('canceled')
  })

  test('a running task whose PARKED time exceeds the cap is NOT canceled — only running time counts', async () => {
    const id = await seed('pending', { maxDurationMs: 10_000 })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['pending'],
      reason: 't',
      now: T0,
    })
    await setTaskStatus({
      db,
      taskId: id,
      to: 'awaiting_human',
      allowedFrom: ['running'],
      reason: 'park',
      now: T0 + 3_000, // 3s of running before parking
    })
    // Unpark after an HOUR parked; the task is running again.
    const unpark = T0 + 3_605_000
    await setTaskStatus({
      db,
      taskId: id,
      to: 'running',
      allowedFrom: ['awaiting_human'],
      reason: 'unpark',
      now: unpark,
    })
    // 2s into the new stretch: total RUNNING = 3s + 2s = 5s < 10s cap, even
    // though wall-clock elapsed is over an hour. The task is scanned (it IS
    // running) but must survive — proving enforceLimits reads runningMs, not
    // wall-clock. Killing it here is exactly the RFC-207 §3.8 bug.
    const r = await enforceLimits(db, unpark + 2_000)
    expect(r.scanned).toBeGreaterThanOrEqual(1) // it WAS examined
    expect(r.canceled).not.toContain(id)
    expect((await db.select().from(tasks).where(eq(tasks.id, id)))[0]!.status).toBe('running')
  })
})

describe('RFC-207 accounting columns are not caller-writable (B2-lifecycle-3 guard)', () => {
  test('the extra type rejects runningMs / runningSince', () => {
    // Compile-time lock: extra spreads AFTER the computed accounting, so allowing
    // these would let a caller clobber it silently. TaskStatusUpdateExtra must
    // not include them. `@ts-expect-error` fails to compile (TS2353) only while
    // the exclusion holds — remove either field from the Pick and this reds.
    const bad = () =>
      setTaskStatus({
        db,
        taskId: 'x',
        to: 'running',
        allowedFrom: ['pending'],
        reason: 'test',
        // @ts-expect-error — runningMs is computed by writeStatus, never caller-set (RFC-207)
        extra: { runningMs: 999 },
      })
    expect(typeof bad).toBe('function')
  })
})
