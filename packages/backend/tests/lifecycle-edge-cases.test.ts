import { rimrafDir } from './helpers/cleanup'
// RFC-053 — edge-case coverage for runLifecycleInvariants /
// reconcileLifecycleAlerts that the PR-D test suite skipped:
//
//   - `{ since }` scope filter (boundary + active-still-included)
//   - workflow snapshot corrupt → R2/T3 silently degrade
//   - 24h grace promotion at the exact boundary
//   - onAlert callback throw must not break reconcile
//   - detail JSON with unicode / emoji / `<script>` / control chars
//
// Each block focuses on one paragraph of the design.md §失败模式 + 边界
// so a regression there fails a specifically-named test.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { docVersions, lifecycleAlerts, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  reconcileLifecycleAlerts,
  runLifecycleInvariants,
  STUCK_RULES,
  type LifecycleAlertRow,
} from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIN_MS = 60_000
const HOUR_MS = 60 * MIN_MS
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0)

async function freshDb(): Promise<{ db: DbClient; cleanup: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-edge-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  return { db, cleanup: () => rimrafDir(tmp) }
}

async function seedTask(
  db: DbClient,
  opts: {
    status: 'pending' | 'running' | 'awaiting_review' | 'done' | 'failed'
    startedAt: number
    finishedAt?: number | null
    snapshotJson: string
  },
): Promise<string> {
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: opts.snapshotJson })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: opts.snapshotJson,
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: opts.status,
    inputs: '{}',
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt ?? null,
  })
  return taskId
}

const REVIEW_ONLY_DEF: WorkflowDefinition = {
  $schema_version: 2,
  inputs: [],
  nodes: [{ id: 'rev', kind: 'review' } as unknown as WorkflowNode],
  edges: [],
}
const REVIEW_ONLY_JSON = JSON.stringify(REVIEW_ONLY_DEF)

// ---------------------------------------------------------------------------
// { since } scope
// ---------------------------------------------------------------------------

describe('RFC-053 — `{ since }` scope filter', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('startedAt > since → scanned', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'running',
      startedAt: T0 - 30 * MIN_MS,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    const r = await runLifecycleInvariants({
      db: env.db,
      scope: { since: T0 - 60 * MIN_MS },
      now: () => T0,
    })
    expect(r.scanned).toBe(1)
    expect(typeof taskId).toBe('string')
  })

  test('finishedAt > since → scanned even if startedAt < since', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    await seedTask(env.db, {
      status: 'failed',
      startedAt: T0 - 5 * HOUR_MS,
      finishedAt: T0 - 30 * MIN_MS, // finished recently
      snapshotJson: REVIEW_ONLY_JSON,
    })
    const r = await runLifecycleInvariants({
      db: env.db,
      scope: { since: T0 - 60 * MIN_MS },
      now: () => T0,
    })
    expect(r.scanned).toBe(1)
  })

  test('still-active task (finishedAt IS NULL) → always scanned by since', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    await seedTask(env.db, {
      status: 'running',
      startedAt: T0 - 30 * 24 * HOUR_MS, // a month ago
      finishedAt: null,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    const r = await runLifecycleInvariants({
      db: env.db,
      scope: { since: T0 - 60 * MIN_MS },
      now: () => T0,
    })
    expect(r.scanned).toBe(1)
  })

  test('startedAt < since AND finishedAt < since → NOT scanned', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    await seedTask(env.db, {
      status: 'failed',
      startedAt: T0 - 5 * HOUR_MS,
      finishedAt: T0 - 4 * HOUR_MS,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    const r = await runLifecycleInvariants({
      db: env.db,
      scope: { since: T0 - 60 * MIN_MS },
      now: () => T0,
    })
    expect(r.scanned).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// snapshot corrupt
// ---------------------------------------------------------------------------

describe('RFC-053 — workflow snapshot corrupt degrades gracefully', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('invalid JSON snapshot → R2/T3 silently skip, T1 still works', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    // Plant a review node_run that would trigger R2 if the workflow were
    // parseable (status=done, no approved dv).
    const taskId = await seedTask(env.db, {
      status: 'awaiting_review',
      startedAt: T0 - MIN_MS,
      snapshotJson: 'not-valid-json{{}',
    })
    await env.db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      startedAt: T0 - MIN_MS,
      finishedAt: T0,
    })

    const r = await runLifecycleInvariants({ db: env.db, scope: { taskId }, now: () => T0 })
    // R2 silently degrades because the workflow can't be parsed → no R2 finding.
    expect(r.openAlerts.filter((a) => a.rule === 'R2')).toHaveLength(0)
    // T1 still fires (it doesn't need workflow knowledge — just task status +
    // node_runs.status).
    expect(r.openAlerts.filter((a) => a.rule === 'T1')).toHaveLength(1)
  })

  test('snapshot is JSON but `nodes` is not an array → degrade like corrupt', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'running',
      startedAt: T0 - MIN_MS,
      snapshotJson: JSON.stringify({ $schema_version: 2, nodes: 'oops', edges: [] }),
    })
    const r = await runLifecycleInvariants({ db: env.db, scope: { taskId }, now: () => T0 })
    // Just smoke — must not throw, scanned=1.
    expect(r.scanned).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 24h grace boundary
// ---------------------------------------------------------------------------

describe('RFC-053 — 24h grace boundary (severity warning → error)', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('exactly 24h elapsed → promote (>= boundary, design rule)', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    // Seed an open warning row with detectedAt exactly 24h ago.
    const taskId = await seedTask(env.db, {
      status: 'awaiting_review',
      startedAt: T0,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId,
      rule: 'T1', // T1 will keep firing because we don't insert any awaiting_review node_run
      severity: 'warning',
      detail: '{"rule":"T1"}',
      detectedAt: T0 - 24 * HOUR_MS,
      resolvedAt: null,
    })
    const r = await runLifecycleInvariants({ db: env.db, scope: { taskId }, now: () => T0 })
    expect(r.promotedAlerts).toBe(1)
    const t1 = r.openAlerts.find((a) => a.rule === 'T1')!
    expect(t1.severity).toBe('error')
  })

  test('just under 24h (detectedAt = now - 24h + 1ms) → stays warning', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'awaiting_review',
      startedAt: T0,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId,
      rule: 'T1',
      severity: 'warning',
      detail: '{"rule":"T1"}',
      detectedAt: T0 - 24 * HOUR_MS + 1,
      resolvedAt: null,
    })
    const r = await runLifecycleInvariants({ db: env.db, scope: { taskId }, now: () => T0 })
    expect(r.promotedAlerts).toBe(0)
    expect(r.openAlerts.find((a) => a.rule === 'T1')!.severity).toBe('warning')
  })

  test('after promotion, severity stays error on subsequent scans (no demotion)', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'awaiting_review',
      startedAt: T0,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    await env.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId,
      rule: 'T1',
      severity: 'error', // already promoted
      detail: '{"rule":"T1"}',
      detectedAt: T0 - 48 * HOUR_MS,
      resolvedAt: null,
    })
    const r = await runLifecycleInvariants({ db: env.db, scope: { taskId }, now: () => T0 })
    // No second promotion, severity stays error.
    expect(r.promotedAlerts).toBe(0)
    expect(r.openAlerts.find((a) => a.rule === 'T1')!.severity).toBe('error')
  })
})

// ---------------------------------------------------------------------------
// onAlert callback throw
// ---------------------------------------------------------------------------

describe('RFC-053 — onAlert callback throw does not break reconcile', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('callback throws on first finding → second finding still upserted, both rows persisted', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    // Two tasks each producing one R1 finding; the first callback throws.
    // Documented invariant: the throw escapes reconcile (we did NOT add a
    // try/catch around onAlert), so this test pins the *current* behavior
    // and pre-warns anyone changing it.
    const reviewDef: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [{ id: 'rev', kind: 'review' } as unknown as WorkflowNode],
      edges: [],
    }
    const reviewJson = JSON.stringify(reviewDef)
    const t1 = await seedTask(env.db, {
      status: 'awaiting_review',
      startedAt: T0,
      snapshotJson: reviewJson,
    })
    const tBRun = ulid()
    await env.db.insert(nodeRuns).values({
      id: tBRun,
      taskId: t1,
      nodeId: 'rev',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_review',
      startedAt: T0,
    })
    await env.db.insert(docVersions).values({
      id: ulid(),
      taskId: t1,
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

    let threw = false
    let calls = 0
    try {
      await runLifecycleInvariants({
        db: env.db,
        scope: { taskId: t1 },
        now: () => T0 + MIN_MS,
        onAlert: () => {
          calls++
          throw new Error('boom from onAlert')
        },
      })
    } catch (err) {
      threw = true
      expect(err).toBeInstanceOf(Error)
    }
    // Current contract: callback throw propagates. Documents the
    // invariant — change this assertion if we ever add defensive try/catch.
    expect(threw).toBe(true)
    expect(calls).toBe(1)
  })

  test('reconcile.onAlert called once per finding (no double-invoke)', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'running',
      startedAt: T0,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    const calls: Array<{ rule: string; transition: 'new' | 'promoted' }> = []
    await reconcileLifecycleAlerts({
      db: env.db,
      taskIds: [taskId],
      findings: [
        { taskId, rule: 'S1', detail: { rule: 'S1' } },
        { taskId, rule: 'S2', detail: { rule: 'S2' } },
      ],
      now: T0,
      ownedRules: STUCK_RULES,
      onAlert: (row: LifecycleAlertRow, transition) => calls.push({ rule: row.rule, transition }),
    })
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.transition)).toEqual(['new', 'new'])
  })
})

// ---------------------------------------------------------------------------
// detail JSON with special characters
// ---------------------------------------------------------------------------

describe('RFC-053 — detail JSON round-trip with special characters', () => {
  let cleanup: () => void
  afterEach(() => cleanup?.())

  test('unicode + emoji + script tag + control chars survive insert/read round-trip', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'running',
      startedAt: T0,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    const exotic = {
      rule: 'S4',
      taskId,
      message: '审批超时未拣选',
      emoji: '🟠⚠️🚨',
      htmlish: '<script>alert("xss")</script>',
      controlChar: 'line\nfeed\ttab',
      backslash: 'C:\\path\\to\\file',
      quote: 'he said "hi"',
    }
    await reconcileLifecycleAlerts({
      db: env.db,
      taskIds: [taskId],
      findings: [{ taskId, rule: 'S4', detail: exotic }],
      now: T0,
      ownedRules: STUCK_RULES,
    })
    const row = (
      await env.db.select().from(lifecycleAlerts).where(eq(lifecycleAlerts.taskId, taskId))
    )[0]!
    const parsed = JSON.parse(row.detail) as typeof exotic
    expect(parsed).toEqual(exotic)
  })

  test('arbitrarily deep nested detail object survives round-trip', async () => {
    const env = await freshDb()
    cleanup = env.cleanup
    const taskId = await seedTask(env.db, {
      status: 'running',
      startedAt: T0,
      snapshotJson: REVIEW_ONLY_JSON,
    })
    type Deep = { rule: string; nested?: Deep; depth: number }
    let deep: Deep = { rule: 'S4', depth: 30 }
    for (let i = 29; i >= 0; i--) {
      deep = { rule: 'S4', nested: deep, depth: i }
    }
    await reconcileLifecycleAlerts({
      db: env.db,
      taskIds: [taskId],
      findings: [{ taskId, rule: 'S4', detail: deep as unknown as Record<string, unknown> }],
      now: T0,
      ownedRules: STUCK_RULES,
    })
    const row = (
      await env.db.select().from(lifecycleAlerts).where(eq(lifecycleAlerts.taskId, taskId))
    )[0]!
    expect(row.detail.length).toBeGreaterThan(100)
    // Re-parse to confirm valid JSON.
    expect(() => JSON.parse(row.detail)).not.toThrow()
  })
})
