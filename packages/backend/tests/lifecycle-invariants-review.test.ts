import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-D — invariants R1/R2 (review ↔ doc_versions / node_runs).
//
// Calls the real services/lifecycleInvariants.runLifecycleInvariants(); each
// case constructs a single-task DB shape that either satisfies or violates
// the rule and asserts that:
//   - the right `rule` is in (or absent from) result.openAlerts
//   - the row landed in lifecycle_alerts with severity='warning' on first
//     scan (24h grace) and gets promoted to 'error' on a later scan past
//     the 24h boundary
//   - resolved findings (no longer violating) flip resolved_at to now
//
// Sibling files cover C1 (clarify), T1/T2/T3/U1 (task ↔ node_runs / U1
// dup-active), migration smoke, and route.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq, isNull, and } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import { docVersions, lifecycleAlerts, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runLifecycleInvariants, type LifecycleAlertRow } from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const HOUR_MS = 3_600_000

type HarnessTaskStatus =
  | 'pending'
  | 'running'
  | 'awaiting_review'
  | 'awaiting_human'
  | 'done'
  | 'failed'
  | 'canceled'
  | 'interrupted'

interface Harness {
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function buildHarness(taskStatus: HarnessTaskStatus): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-prd-review-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  // Single review node only — tests focus on R1/R2 specifically. Avoid
  // adding output/clarify nodes that would activate sibling rules and
  // make per-rule assertions noisier.
  const def: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      } as unknown as WorkflowNode,
    ],
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
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now(),
  })
  return { db, taskId, cleanup: () => rimrafDir(tmp) }
}

async function insertReviewRun(
  db: DbClient,
  taskId: string,
  opts: { status: HarnessTaskStatus | 'skipped' | 'exhausted'; finishedAt?: number | null },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'rev_1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: opts.status,
    startedAt: Date.now() - 100,
    finishedAt: opts.finishedAt ?? null,
  })
  return id
}

async function insertDoc(
  db: DbClient,
  taskId: string,
  opts: {
    reviewNodeRunId: string
    decision: 'pending' | 'approved' | 'rejected' | 'iterated'
    versionIndex: number
  },
): Promise<string> {
  const id = ulid()
  await db.insert(docVersions).values({
    id,
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId: opts.reviewNodeRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'docpath',
    versionIndex: opts.versionIndex,
    reviewIteration: 0,
    bodyPath: `dv/v${opts.versionIndex}.md`,
    decision: opts.decision,
    decidedAt: opts.decision === 'pending' ? null : Date.now(),
  })
  return id
}

function rulesOf(alerts: LifecycleAlertRow[]): string[] {
  return alerts.map((a) => a.rule).sort()
}

describe('RFC-053 PR-D — R1 (approved doc_version ⟹ done review node_run)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: approved doc + done review run → no alert', async () => {
    h = await buildHarness('done')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'done', finishedAt: Date.now() })
    await insertDoc(h.db, h.taskId, { reviewNodeRunId: run, decision: 'approved', versionIndex: 1 })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(rulesOf(result.openAlerts)).toEqual([])
  })

  test('violated: approved doc + awaiting_review run → R1 alert (RFC-052 shape)', async () => {
    h = await buildHarness('awaiting_review')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'awaiting_review' })
    const dv = await insertDoc(h.db, h.taskId, {
      reviewNodeRunId: run,
      decision: 'approved',
      versionIndex: 1,
    })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const r1 = result.openAlerts.filter((a) => a.rule === 'R1')
    expect(r1).toHaveLength(1)
    expect(r1[0]!.severity).toBe('warning')
    expect(r1[0]!.detail).toMatchObject({
      reviewNodeRunId: run,
      docVersionId: dv,
      actualStatus: 'awaiting_review',
    })
  })

  test('promoted: warning → error 24h after first detection', async () => {
    h = await buildHarness('awaiting_review')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'awaiting_review' })
    await insertDoc(h.db, h.taskId, { reviewNodeRunId: run, decision: 'approved', versionIndex: 1 })
    const t0 = Date.UTC(2026, 0, 1)
    let calls: Array<{ row: LifecycleAlertRow; transition: 'new' | 'promoted' }> = []
    const onAlert = (row: LifecycleAlertRow, transition: 'new' | 'promoted'): void => {
      calls.push({ row, transition })
    }
    // First scan: warning + 'new' callback
    const r1 = await runLifecycleInvariants({
      db: h.db,
      scope: { taskId: h.taskId },
      now: () => t0,
      onAlert,
    })
    expect(r1.newAlerts).toBe(1)
    expect(r1.promotedAlerts).toBe(0)
    expect(r1.openAlerts[0]!.severity).toBe('warning')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.transition).toBe('new')

    // Second scan, within 24h: still warning, no callback
    calls = []
    const r2 = await runLifecycleInvariants({
      db: h.db,
      scope: { taskId: h.taskId },
      now: () => t0 + 23 * HOUR_MS,
      onAlert,
    })
    expect(r2.newAlerts).toBe(0)
    expect(r2.promotedAlerts).toBe(0)
    expect(r2.openAlerts[0]!.severity).toBe('warning')
    expect(calls).toHaveLength(0)

    // Third scan, past 24h: promoted to error + 'promoted' callback fires once
    calls = []
    const r3 = await runLifecycleInvariants({
      db: h.db,
      scope: { taskId: h.taskId },
      now: () => t0 + 25 * HOUR_MS,
      onAlert,
    })
    expect(r3.newAlerts).toBe(0)
    expect(r3.promotedAlerts).toBe(1)
    expect(r3.openAlerts[0]!.severity).toBe('error')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.transition).toBe('promoted')

    // Fourth scan, still violating: no second promotion (only one transition per row)
    calls = []
    const r4 = await runLifecycleInvariants({
      db: h.db,
      scope: { taskId: h.taskId },
      now: () => t0 + 48 * HOUR_MS,
      onAlert,
    })
    expect(r4.promotedAlerts).toBe(0)
    expect(calls).toHaveLength(0)
  })

  test('resolved: fix the run status → scan flips resolved_at on the R1 row', async () => {
    h = await buildHarness('awaiting_review')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'awaiting_review' })
    await insertDoc(h.db, h.taskId, { reviewNodeRunId: run, decision: 'approved', versionIndex: 1 })
    // First scan: R1 violates (T1 also satisfied — there *is* an awaiting_review run).
    const r1 = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(r1.openAlerts.filter((a) => a.rule === 'R1')).toHaveLength(1)
    // Fix shape: run becomes done, task moves to done too so T1 doesn't fire.
    await h.db
      .update(nodeRuns)
      .set({ status: 'done', finishedAt: Date.now() })
      .where(eq(nodeRuns.id, run))
    await h.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, h.taskId))
    // Second scan: R1 row resolved; no new R1 inserted.
    const r2 = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(r2.resolvedAlerts).toBeGreaterThanOrEqual(1)
    expect(r2.openAlerts.filter((a) => a.rule === 'R1')).toHaveLength(0)
    // Historical R1 row exists with resolved_at set.
    const allR1 = await h.db
      .select()
      .from(lifecycleAlerts)
      .where(and(eq(lifecycleAlerts.taskId, h.taskId), eq(lifecycleAlerts.rule, 'R1')))
    expect(allR1).toHaveLength(1)
    expect(allR1[0]!.resolvedAt).not.toBeNull()
  })
})

describe('RFC-053 PR-D — R2 (done review node_run ⟹ ∃ approved doc_version)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('satisfied: done review run + approved dv → no alert', async () => {
    h = await buildHarness('done')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'done', finishedAt: Date.now() })
    await insertDoc(h.db, h.taskId, { reviewNodeRunId: run, decision: 'approved', versionIndex: 1 })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'R2')).toHaveLength(0)
  })

  test('violated: done review run with only rejected doc_version → R2 alert', async () => {
    h = await buildHarness('failed')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'done', finishedAt: Date.now() })
    await insertDoc(h.db, h.taskId, { reviewNodeRunId: run, decision: 'rejected', versionIndex: 1 })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const r2 = result.openAlerts.filter((a) => a.rule === 'R2')
    expect(r2).toHaveLength(1)
    expect(r2[0]!.detail).toMatchObject({ reviewNodeRunId: run, reviewNodeId: 'rev_1' })
  })

  test('violated: done review run with no doc_version at all → R2 alert', async () => {
    h = await buildHarness('failed')
    await insertReviewRun(h.db, h.taskId, { status: 'done', finishedAt: Date.now() })
    const result = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(result.openAlerts.filter((a) => a.rule === 'R2')).toHaveLength(1)
  })

  test('open-row uniqueness: per (task, rule) only one open row at a time', async () => {
    h = await buildHarness('failed')
    const run = await insertReviewRun(h.db, h.taskId, { status: 'done', finishedAt: Date.now() })
    // Two scans without fixing the violation: still 1 open row, no dup insert.
    const r1 = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(r1.newAlerts).toBe(1)
    const r2 = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(r2.newAlerts).toBe(0)
    expect(r2.openAlerts.filter((a) => a.rule === 'R2')).toHaveLength(1)
    const openR2 = await h.db
      .select()
      .from(lifecycleAlerts)
      .where(
        and(
          eq(lifecycleAlerts.taskId, h.taskId),
          eq(lifecycleAlerts.rule, 'R2'),
          isNull(lifecycleAlerts.resolvedAt),
        ),
      )
    expect(openR2).toHaveLength(1)
    // Reference the bound `run` so the variable is observably used by the harness.
    expect(typeof run).toBe('string')
  })
})
