// CURRENT-BEHAVIOR LOCK — design/scheduler-audit-2026-06-10.md §⑥ 缺口1 (limits 墙钟把暂停时长计入)
//
// 当前缺陷行为（已对照源码核实）：
//   - `enforceLimits` 以 `now - tasks.startedAt` 判 maxDurationMs
//     （src/services/limits.ts:63-70）。
//   - `tasks.startedAt` 只在 startTask 落行时写一次（src/services/task.ts:697）。
//   - `resumeTask` 翻 pending 时只清 status/finishedAt/error 字段，不重置
//     startedAt（src/services/task.ts:1010-1018）。
//   - 调度器 mark-running 也只写 `{status:'running'}`，同样不碰 startedAt
//     （src/services/scheduler.ts:262）。
//   ⇒ interrupted / awaiting_review / awaiting_human 的暂停时长全部计入墙钟。
//   一个实际只跑了几秒、但被搁置 7 天后 resume 的任务，会在 1Hz limits tick 的
//   第一拍就被 `task-time-limit-exceeded` 取消。
//
// 正确语义应是：maxDurationMs 度量"任务实际运行时长"（至少应在 resume 时重置
// startedAt，或按 running 区间累计），长暂停后恢复的任务不应被秒杀。
//
// 修复归属：报告 ⑥-1（建议补的就是本场景）；与 WP-4（nextTaskStatus CAS——
// limits.ts:47-50 在 cancelTask 后对 errorSummary 的无条件覆写也是盲写点）相邻。
// 修复时本文件应翻红：
//   - 若修法是 resume 重置 startedAt：下面 "preserves the stale startedAt" 的两处
//     toBe(STALE) 断言翻红 → 改为断言 startedAt 接近 resume 时刻。
//   - 若修法是按 running 区间累计：最后一个 test 的 canceled 断言翻红 → 改为
//     断言任务存活（canceled 为空）。

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { monotonicFactory } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { enforceLimits } from '../src/services/limits'
import { resumeTask } from '../src/services/task'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DAY_MS = 24 * 60 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000

interface Harness {
  db: DbClient
  appHome: string
  cleanup: () => void
}

function buildHarness(): Harness {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-gap1-limits-'))
  const db = createInMemoryDb(MIGRATIONS)
  return { db, appHome, cleanup: () => rmSync(appHome, { recursive: true, force: true }) }
}

// Empty workflow: resumeTask's fire-and-forget runTask parses it, marks the
// task running, finds zero scope nodes (allSettled) and lands 'done' without
// ever spawning opencode or touching git — keeps this test pure DB-level.
const EMPTY_DEF = JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] })

async function seedTask(
  db: DbClient,
  overrides: Partial<typeof tasks.$inferInsert>,
): Promise<string> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: EMPTY_DEF,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  // RFC-108 T6 (AR-15): resumeTask now 410s on a MISSING worktree dir (gc
  // reclaim). This DB-level fixture used a non-existent '/tmp/wt' stub; give it a
  // present dir so the existence pre-flight passes (still no git ops — empty wf).
  const wt = mkdtempSync(join(tmpdir(), 'aw-gap1-wt-'))
  await db.insert(tasks).values({
    name: 'fixture-task',
    id: taskId,
    workflowId,
    workflowSnapshot: EMPTY_DEF,
    repoPath: '/tmp/repo',
    worktreePath: wt,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
    ...overrides,
  })
  return taskId
}

async function readTask(db: DbClient, id: string) {
  return (await db.select().from(tasks).where(eq(tasks.id, id)))[0]
}

// resumeTask fire-and-forgets runTask (`void runTask(...)`, task.ts:1028) and
// — unlike startTask — does NOT honor deps.awaitScheduler, so there is no
// deterministic join handle. Bounded condition-poll on the DB row until the
// background scheduler pass settles; converges in a few ms for the empty
// workflow above (cancelTask itself uses the same Bun.sleep-poll pattern).
async function waitForTerminal(db: DbClient, id: string): Promise<string> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const t = await readTask(db, id)
    const s = t?.status ?? ''
    if (s !== 'pending' && s !== 'running') return s
    await Bun.sleep(10)
  }
  throw new Error('background runTask did not settle within 5s')
}

describe('gap1 — pause time counts toward maxDurationMs wall clock (current-behavior lock)', () => {
  let h: Harness
  beforeEach(() => {
    h = buildHarness()
  })
  afterEach(() => h.cleanup())

  test('paused (interrupted) task is invisible to enforceLimits — the kill only arms after resume', async () => {
    const STALE = Date.now() - 7 * DAY_MS
    const taskId = await seedTask(h.db, {
      status: 'interrupted',
      startedAt: STALE,
      finishedAt: Date.now() - 5 * DAY_MS,
      maxDurationMs: ONE_HOUR_MS,
    })
    // limits only scans status='running' (limits.ts:33) — the 7-day-old
    // startedAt is harmless while the task stays parked.
    const r = await enforceLimits(h.db)
    expect(r.scanned).toBe(0)
    expect(r.canceled).toEqual([])
    const t = await readTask(h.db, taskId)
    expect(t?.status).toBe('interrupted')
  })

  test('resumeTask + the full scheduler pass preserve the stale startedAt (task.ts:1010-1018 / scheduler.ts:262 both omit it)', async () => {
    const STALE = Date.now() - 7 * DAY_MS
    const taskId = await seedTask(h.db, {
      status: 'interrupted',
      startedAt: STALE,
      finishedAt: Date.now() - 5 * DAY_MS,
      errorSummary: 'daemon-restart',
      errorMessage: 'daemon restarted while this task was running; please resume',
    })

    const returned = await resumeTask(h.db, taskId, {
      db: h.db,
      appHome: h.appHome,
      opencodeCmd: ['/usr/bin/env', 'true'], // never spawned: empty workflow
    })
    expect(returned.status).toBe('pending')

    // DEFECT LOCK #1: resumeTask's own UPDATE (already committed before it
    // returns) clears status/finishedAt/error fields but NOT startedAt.
    // After a "reset startedAt on resume" fix this turns red — assert a
    // fresh (≈ now) startedAt instead.
    const afterResume = await readTask(h.db, taskId)
    expect(afterResume?.startedAt).toBe(STALE)

    // DEFECT LOCK #2: join the background scheduler pass (pending → running
    // → done) and re-check — runTask's mark-running writes only {status}
    // (scheduler.ts:262), so the stale clock survives the whole resume cycle.
    const terminal = await waitForTerminal(h.db, taskId)
    expect(terminal).toBe('done')
    const afterRun = await readTask(h.db, taskId)
    expect(afterRun?.startedAt).toBe(STALE)
  })

  test('a resumed task in its running window is immediately killed: 7-day pause > 1h cap although it never ran 1h', async () => {
    // Seed directly in the exact shape the previous test PROVED a resumed
    // task reaches mid-run: status='running' with the pre-pause startedAt
    // (neither resumeTask:1010-1018 nor scheduler.ts:262 reset it). Seeding
    // avoids racing the real background runTask between its mark-running and
    // mark-done writes — determinism per the audit test rules.
    const STALE = Date.now() - 7 * DAY_MS
    const taskId = await seedTask(h.db, {
      status: 'running',
      startedAt: STALE,
      maxDurationMs: ONE_HOUR_MS,
    })

    const r = await enforceLimits(h.db)

    // RFC-207 §3.8 — FIXED. This assertion is the inverse of the defect lock it
    // replaces (which the file header pre-declared would flip): a task that sat
    // parked for 7 days has accumulated no running time, so the first tick after
    // it resumes must NOT kill it. `startedAt` deliberately still reads stale —
    // eight other consumers treat it as "when was this task created".
    expect(r.canceled).toEqual([])
    const t = await readTask(h.db, taskId)
    expect(t?.status).toBe('running')
    expect(t?.startedAt).toBe(STALE)
  })

  test('accumulated running time still trips the cap — the limit is not defanged', async () => {
    // The mirror of the case above: real running time (an OPEN stretch, i.e. the
    // task genuinely running) is charged normally. Without this, "park time is
    // free" could be implemented by never charging anything at all.
    const taskId = await seedTask(h.db, {
      status: 'running',
      startedAt: Date.now() - 2 * ONE_HOUR_MS,
      runningSince: Date.now() - 2 * ONE_HOUR_MS,
      maxDurationMs: ONE_HOUR_MS,
    })
    const r = await enforceLimits(h.db)
    expect(r.canceled).toEqual([taskId])
    expect((await readTask(h.db, taskId))?.errorSummary).toBe('task-time-limit-exceeded')
  })
})
