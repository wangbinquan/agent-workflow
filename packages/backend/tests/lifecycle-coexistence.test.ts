import { rimrafDir } from './helpers/cleanup'
// RFC-053 — coexistence + isolation tests across the two writers
// (lifecycle invariants in PR-D + stuck-task detector in PR-E).
//
// The same `lifecycle_alerts` table holds rows from both modules; the
// `ownedRules` arg to `reconcileLifecycleAlerts` is the correctness gate
// that keeps one module's pass from accidentally resolving the other's
// open rows. These cases lock that contract + the multi-task / deleted
// / terminal skip paths that are easy to break with a one-line SQL edit.

import { afterEach, describe, expect, test } from 'bun:test'
import { and, eq, isNull } from 'drizzle-orm'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, lifecycleAlerts, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIN_MS = 60_000
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

interface SeededTask {
  taskId: string
}

async function seedTask(
  db: DbClient,
  status:
    | 'pending'
    | 'running'
    | 'awaiting_review'
    | 'awaiting_human'
    | 'done'
    | 'canceled'
    | 'failed'
    | 'interrupted',
  opts: {
    nodes?: WorkflowNode[]
    startedAt?: number
    deletedAt?: number | null
  } = {},
): Promise<SeededTask> {
  const def: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: opts.nodes ?? [],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt: opts.startedAt ?? T0 - 10 * MIN_MS,
    deletedAt: opts.deletedAt ?? null,
  })
  return { taskId }
}

async function freshDb(): Promise<{ db: DbClient; cleanup: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-coexist-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return { db, cleanup: () => rimrafDir(tmp) }
}

describe('RFC-053 — invariants + stuck-detector共存（同一 task 同时被两者写）', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('invariants run does NOT resolve stuck-detector open rows', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const t1 = await seedTask(env.db, 'awaiting_review', {
      nodes: [{ id: 'rev', kind: 'review' } as unknown as WorkflowNode],
    })
    // Plant an R1 violation (stuck review approved-but-not-done).
    const runId = ulid()
    await env.db.insert(nodeRuns).values({
      id: runId,
      taskId: t1.taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: T0,
    })
    await env.db.insert(docVersions).values({
      id: ulid(),
      taskId: t1.taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId: runId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'd/v1.md',
      decision: 'approved',
      decidedAt: T0,
    })
    // Also a separate S1 violation (awaiting_review > 30 min, but no pending dv).
    // It IS true that S1 won't fire here because there's no pending dv but R1
    // already covers the symptom — so plant a synthetic stuck row directly via
    // the stuck detector by elapsing time. But to keep the test focused, just
    // INSERT a fake S1 row to simulate "stuck detector already found one".
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId: t1.taskId,
      rule: 'S1',
      severity: 'warning',
      detail: '{"rule":"S1","seeded":true}',
      detectedAt: T0,
      resolvedAt: null,
    })

    // Run only invariants. R1 should be inserted; S1 must NOT be resolved.
    await runLifecycleInvariants({
      db: env.db,
      scope: { taskId: t1.taskId },
      now: () => T0 + MIN_MS,
    })

    const rows = await env.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, t1.taskId))
    const s1 = rows.find((r) => r.rule === 'S1')!
    expect(s1.resolvedAt).toBeNull()
    expect(rows.some((r) => r.rule === 'R1')).toBe(true)
  })

  test('stuck-detector run does NOT resolve invariant open rows', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const t1 = await seedTask(env.db, 'pending', { startedAt: T0 - 10 * MIN_MS })
    // Seed an open R1 row that the stuck detector should leave untouched.
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId: t1.taskId,
      rule: 'R1',
      severity: 'warning',
      detail: '{"rule":"R1","seeded":true}',
      detectedAt: T0 - 60 * MIN_MS,
      resolvedAt: null,
    })

    await runStuckTaskDetector({ db: env.db, now: () => T0 })

    const rows = await env.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, t1.taskId))
    const r1 = rows.find((r) => r.rule === 'R1')!
    expect(r1.resolvedAt).toBeNull()
    expect(rows.some((r) => r.rule === 'S4')).toBe(true)
  })
})

describe('RFC-053 — multi-task reconcile isolation', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('mix of fix / still-broken / newly-broken across 3 tasks → resolve 1, keep 1, insert 1', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    // tA: had R1 violation, now fixed (we'll seed an open row, then make the
    //     shape healthy and let reconcile flip it).
    // tB: still has the R1 violation.
    // tC: brand new R1 violation appearing this pass.
    const reviewNode: WorkflowNode = {
      id: 'rev',
      kind: 'review',
    } as unknown as WorkflowNode
    const tA = await seedTask(env.db, 'failed', { nodes: [reviewNode] })
    const tB = await seedTask(env.db, 'awaiting_review', { nodes: [reviewNode] })
    const tC = await seedTask(env.db, 'awaiting_review', { nodes: [reviewNode] })

    // Seed an OPEN R1 row for tA (will be resolved this pass).
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId: tA.taskId,
      rule: 'R1',
      severity: 'warning',
      detail: '{"rule":"R1","seeded":true}',
      detectedAt: T0 - 30 * MIN_MS,
      resolvedAt: null,
    })

    // Set up tB's broken shape.
    const tBRun = ulid()
    await env.db.insert(nodeRuns).values({
      id: tBRun,
      taskId: tB.taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review', // ← bug
      startedAt: T0,
    })
    await env.db.insert(docVersions).values({
      id: ulid(),
      taskId: tB.taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId: tBRun,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'd/v1.md',
      decision: 'approved',
      decidedAt: T0,
    })

    // Seed an OPEN R1 row for tB too (still violating, will stay open).
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId: tB.taskId,
      rule: 'R1',
      severity: 'warning',
      detail: '{"rule":"R1","seeded":true}',
      detectedAt: T0 - 30 * MIN_MS,
      resolvedAt: null,
    })

    // Set up tC: broken, NO open row → should insert.
    const tCRun = ulid()
    await env.db.insert(nodeRuns).values({
      id: tCRun,
      taskId: tC.taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: T0,
    })
    await env.db.insert(docVersions).values({
      id: ulid(),
      taskId: tC.taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId: tCRun,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'd/v1.md',
      decision: 'approved',
      decidedAt: T0,
    })

    const result = await runLifecycleInvariants({ db: env.db, now: () => T0 + MIN_MS })

    // tA: resolved
    const tARows = await env.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, tA.taskId))
    expect(tARows.filter((r) => r.rule === 'R1' && r.resolvedAt === null)).toHaveLength(0)

    // tB: kept open (still violates)
    const tBRows = await env.db
      .select()
      .from(lifecycleAlerts)
      .where(and(eq(lifecycleAlerts.taskId, tB.taskId), isNull(lifecycleAlerts.resolvedAt)))
    expect(tBRows.filter((r) => r.rule === 'R1')).toHaveLength(1)

    // tC: new insert
    const tCRows = await env.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, tC.taskId))
    expect(tCRows.filter((r) => r.rule === 'R1' && r.resolvedAt === null)).toHaveLength(1)

    // Result counts add up: 1 resolved + 1 inserted (tB had pre-existing
    // open row so it does not count as new).
    expect(result.resolvedAlerts).toBe(1)
    expect(result.newAlerts).toBe(1)
  })
})

describe('RFC-053 — deleted task is invisible to both modules', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('invariants: deleted task is NOT scanned regardless of violations', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const t = await seedTask(env.db, 'awaiting_review', {
      deletedAt: T0 - 60 * MIN_MS,
      nodes: [{ id: 'rev', kind: 'review' } as unknown as WorkflowNode],
    })
    // Plant a violation; deleted task should still be skipped.
    const runId = ulid()
    await env.db.insert(nodeRuns).values({
      id: runId,
      taskId: t.taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: T0,
    })
    await env.db.insert(docVersions).values({
      id: ulid(),
      taskId: t.taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId: runId,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'd/v1.md',
      decision: 'approved',
      decidedAt: T0,
    })
    const r = await runLifecycleInvariants({ db: env.db, now: () => T0 + MIN_MS })
    expect(r.scanned).toBe(0)
    expect(r.openAlerts).toEqual([])
  })

  test('stuck-detector: deleted task is NOT a candidate', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    await seedTask(env.db, 'pending', {
      deletedAt: T0 - 60 * MIN_MS,
      startedAt: T0 - 30 * MIN_MS,
    })
    const r = await runStuckTaskDetector({ db: env.db, now: () => T0 })
    expect(r.scanned).toBe(0)
    expect(r.openAlerts).toEqual([])
  })
})

describe('RFC-053 — terminal task is invisible to stuck-detector', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('stuck-detector: task.status=done is NOT a candidate even if startedAt > threshold', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    await seedTask(env.db, 'done', { startedAt: T0 - 24 * 60 * MIN_MS })
    const r = await runStuckTaskDetector({ db: env.db, now: () => T0 })
    expect(r.scanned).toBe(0)
  })

  test('stuck-detector: task.status=canceled is NOT a candidate', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    await seedTask(env.db, 'canceled', { startedAt: T0 - 24 * 60 * MIN_MS })
    const r = await runStuckTaskDetector({ db: env.db, now: () => T0 })
    expect(r.scanned).toBe(0)
  })
})
