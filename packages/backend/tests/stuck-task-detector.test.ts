// RFC-053 PR-E — stuck-task detector (S1/S2/S3/S4), extended by RFC-098 WP-8
// with S5 (running task, active node_run(s), events stalled — the wedged
// opencode child the scheduler audit S-15 called a blind spot).
//
// Each rule has at least one "stuck" case + one "not stuck" case (the
// negative is the freshness gate or the rule's evidence-present clause).
// Tests construct a single task with the relevant supporting rows, then
// call `runStuckTaskDetector` and assert on `openAlerts` filtered to the
// rule under test.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  clarifyRounds,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIN_MS = 60_000
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0) // fixed clock for reproducibility

type TaskStatus = 'pending' | 'running' | 'awaiting_review' | 'awaiting_human'

interface Harness {
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function buildHarness(
  status: TaskStatus,
  startedAt: number,
  nodes: WorkflowNode[] = [],
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-pre-stuck-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const def: WorkflowDefinition = { $schema_version: 2, inputs: [], nodes, edges: [] }
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
    status,
    inputs: '{}',
    startedAt,
  })
  return { db, taskId, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function insertRun(
  db: DbClient,
  taskId: string,
  opts: {
    nodeId: string
    status:
      | 'pending'
      | 'running'
      | 'awaiting_review'
      | 'awaiting_human'
      | 'done'
      | 'failed'
      | 'canceled'
      | 'interrupted'
      | 'skipped'
      | 'exhausted'
    finishedAt?: number | null
  },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: opts.status,
    startedAt: T0 - MIN_MS,
    finishedAt: opts.finishedAt ?? null,
  })
  return id
}

async function insertEvent(db: DbClient, nodeRunId: string, ts: number): Promise<void> {
  await db.insert(nodeRunEvents).values({
    nodeRunId,
    ts,
    kind: 'text',
    payload: '{}',
  })
}

describe('RFC-053 PR-E — S4 (pending too long)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: pending > 5 min → S4 alert', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const s4 = r.openAlerts.filter((a) => a.rule === 'S4')
    expect(s4).toHaveLength(1)
    expect(s4[0]!.detail).toMatchObject({
      rule: 'S4',
      pendingForMs: 10 * MIN_MS,
    })
  })

  test('not stuck: pending < 5 min → no S4 alert', async () => {
    h = await buildHarness('pending', T0 - 2 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S4')).toHaveLength(0)
  })
})

describe('RFC-053 PR-E — S1 (awaiting_review without pending dv)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: awaiting_review > 30 min + no pending dv → S1 alert', async () => {
    h = await buildHarness('awaiting_review', T0 - 60 * MIN_MS)
    // No pending doc_version, no events.
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S1')).toHaveLength(1)
  })

  test('not stuck: has a pending dv → no S1 alert', async () => {
    h = await buildHarness('awaiting_review', T0 - 60 * MIN_MS)
    const run = await insertRun(h.db, h.taskId, { nodeId: 'rev', status: 'awaiting_review' })
    await h.db.insert(docVersions).values({
      id: ulid(),
      taskId: h.taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId: run,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'dv/v1.md',
      decision: 'pending',
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S1')).toHaveLength(0)
  })

  test('freshness gate: recent activity < 30 min → no S1 alert', async () => {
    h = await buildHarness('awaiting_review', T0 - 60 * MIN_MS)
    const run = await insertRun(h.db, h.taskId, { nodeId: 'rev', status: 'awaiting_review' })
    await insertEvent(h.db, run, T0 - 5 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S1')).toHaveLength(0)
  })
})

describe('RFC-053 PR-E — S2 (awaiting_human without open clarify_session)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: awaiting_human > 30 min + no open session → S2 alert', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(1)
  })

  test('not stuck: has an open clarify round (self) → no S2 alert', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const srcRun = await insertRun(h.db, h.taskId, { nodeId: 'src', status: 'done' })
    const run = await insertRun(h.db, h.taskId, { nodeId: 'clr', status: 'awaiting_human' })
    // RFC-108 T8 (AR-16): the detector now reads the unified clarify_rounds
    // (self-clarify dual-writes it, RFC-058). Insert an OPEN self round.
    await h.db.insert(clarifyRounds).values({
      id: ulid(),
      taskId: h.taskId,
      kind: 'self',
      askingNodeId: 'src',
      askingNodeRunId: srcRun,
      askingShardKey: null,
      intermediaryNodeId: 'clr',
      intermediaryNodeRunId: run,
      targetConsumerNodeId: null,
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: null,
      directive: null,
      status: 'awaiting_human',
      truncationWarningsJson: null,
      designerRunTriggeredAt: null,
      abandonedAt: null,
      createdAt: T0 - 45 * MIN_MS,
      answeredAt: null,
      answeredBy: null,
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(0)
  })

  test('closed (answered) clarify rounds do NOT save S2 from firing', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const srcRun = await insertRun(h.db, h.taskId, { nodeId: 'src', status: 'done' })
    const run = await insertRun(h.db, h.taskId, { nodeId: 'clr', status: 'awaiting_human' })
    // RFC-108 T8 (AR-16): an ANSWERED round in the unified clarify_rounds is not
    // "open" — S2 must still fire (the task is parked with nothing live to answer).
    await h.db.insert(clarifyRounds).values({
      id: ulid(),
      taskId: h.taskId,
      kind: 'self',
      askingNodeId: 'src',
      askingNodeRunId: srcRun,
      askingShardKey: null,
      intermediaryNodeId: 'clr',
      intermediaryNodeRunId: run,
      targetConsumerNodeId: null,
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      directive: null,
      status: 'answered', // ← closed
      truncationWarningsJson: null,
      designerRunTriggeredAt: null,
      abandonedAt: null,
      createdAt: T0 - 45 * MIN_MS,
      answeredAt: T0 - 40 * MIN_MS,
      answeredBy: null,
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(1)
  })

  // RFC-108 T8 (AR-16) — cross-clarify parks write cross_clarify_sessions +
  // clarify_rounds but NOT the legacy clarify_sessions. S2 must read the
  // unified clarify_rounds table; otherwise a genuinely-answerable cross-clarify
  // task false-fires S2 and the only available repair (S2.demote-task) flips it
  // to interrupted, destroying an in-flight cross-clarify round.
  test('regression: cross-clarify awaiting_human with open clarify_rounds → NO S2', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const askingRun = await insertRun(h.db, h.taskId, { nodeId: 'questioner', status: 'done' })
    const crossRun = await insertRun(h.db, h.taskId, { nodeId: 'xclr', status: 'awaiting_human' })
    await h.db.insert(clarifyRounds).values({
      id: ulid(),
      taskId: h.taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: askingRun,
      askingShardKey: null,
      intermediaryNodeId: 'xclr',
      intermediaryNodeRunId: crossRun,
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: null,
      directive: null,
      status: 'awaiting_human', // ← open cross round (no clarify_sessions row)
      truncationWarningsJson: null,
      designerRunTriggeredAt: null,
      abandonedAt: null,
      createdAt: T0 - 45 * MIN_MS,
      answeredAt: null,
      answeredBy: null,
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(0)
  })
})

describe('RFC-053 PR-E — S3 (running but all node_runs terminal)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: running > 30 min + all runs done → S3 alert', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'done', finishedAt: T0 - 35 * MIN_MS })
    await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'done', finishedAt: T0 - 32 * MIN_MS })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const s3 = r.openAlerts.filter((a) => a.rule === 'S3')
    expect(s3).toHaveLength(1)
    expect(s3[0]!.detail).toMatchObject({ totalRuns: 2, terminalRuns: 2 })
  })

  test('not stuck for S3: at least one running node_run → no S3, but S5 fires instead', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'done', finishedAt: T0 - 35 * MIN_MS })
    await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'running' })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S3')).toHaveLength(0)
    // RFC-098 WP-8: this exact scenario (active run, 60 min of silence) used
    // to be the S-15 blind spot — it is now S5 by definition. Asserted
    // explicitly so the semantics shift is visible, per survey §wp8-wp9.
    expect(r.openAlerts.filter((a) => a.rule === 'S5')).toHaveLength(1)
  })

  test('vacuous: running with empty node_runs → no S3 (different layer)', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    // Deliberately no node_runs → bootstrap state; S3 conservatively skips.
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S3')).toHaveLength(0)
    // ... and no S5 either: there is no active run to be wedged.
    expect(r.openAlerts.filter((a) => a.rule === 'S5')).toHaveLength(0)
  })
})

describe('RFC-098 WP-8 — S5 (running, active runs, events stalled)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: active run + zero events ever → S5 with per-run {nodeRunId,nodeId,pid,lastEventTs}', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    const runId = await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'running' })
    await h.db.update(nodeRuns).set({ pid: 4242 }).where(eq(nodeRuns.id, runId))
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const s5 = r.openAlerts.filter((a) => a.rule === 'S5')
    expect(s5).toHaveLength(1)
    expect(s5[0]!.detail).toMatchObject({
      rule: 'S5',
      inactiveForMs: 60 * MIN_MS,
      thresholdMs: 30 * MIN_MS,
      activeRuns: [{ nodeRunId: runId, nodeId: 'b', pid: 4242, lastEventTs: null }],
    })
  })

  test('stuck: events exist but stalled 40 min ago → S5; lastEventTs reports the run own ts', async () => {
    h = await buildHarness('running', T0 - 120 * MIN_MS)
    const runId = await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'running' })
    await insertEvent(h.db, runId, T0 - 40 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const s5 = r.openAlerts.filter((a) => a.rule === 'S5')
    expect(s5).toHaveLength(1)
    expect(s5[0]!.detail).toMatchObject({
      rule: 'S5',
      inactiveForMs: 40 * MIN_MS,
      activeRuns: [{ nodeRunId: runId, nodeId: 'b', pid: null, lastEventTs: T0 - 40 * MIN_MS }],
    })
  })

  test('freshness gate: events 10 min ago → no S5', async () => {
    h = await buildHarness('running', T0 - 120 * MIN_MS)
    const runId = await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'running' })
    await insertEvent(h.db, runId, T0 - 10 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S5')).toHaveLength(0)
  })

  test('S3 and S5 are mutually exclusive halves of the running branch', async () => {
    // All-terminal → S3 only (locked by the S3 suite); here: a mixed task
    // with one active row lands in S5 only.
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'failed', finishedAt: T0 - 50 * MIN_MS })
    await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'awaiting_review' })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S3')).toHaveLength(0)
    const s5 = r.openAlerts.filter((a) => a.rule === 'S5')
    expect(s5).toHaveLength(1)
    // Only the non-terminal row is listed.
    expect((s5[0]!.detail as { activeRuns: Array<{ nodeId: string }> }).activeRuns).toHaveLength(1)
    expect((s5[0]!.detail as { activeRuns: Array<{ nodeId: string }> }).activeRuns[0]!.nodeId).toBe(
      'b',
    )
  })
})

describe('RFC-053 PR-E — reconcile + WS onAlert', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('second scan with no fix → no second insert, same open row', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    const r1 = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r1.newAlerts).toBe(1)
    const r2 = await runStuckTaskDetector({ db: h.db, now: () => T0 + MIN_MS })
    expect(r2.newAlerts).toBe(0)
    const rows = await h.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, h.taskId))
    expect(rows).toHaveLength(1)
  })

  test('resolution: when the condition lifts the open row gets resolved_at', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    await runStuckTaskDetector({ db: h.db, now: () => T0 })
    // Promote task out of pending.
    await h.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, h.taskId))
    // Give it an active run so S3 doesn't immediately fire.
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'running' })
    const r2 = await runStuckTaskDetector({ db: h.db, now: () => T0 + MIN_MS })
    expect(r2.resolvedAlerts).toBe(1)
    expect(r2.openAlerts.filter((a) => a.rule === 'S4')).toHaveLength(0)
  })

  test('onAlert(new) fires exactly once per new alert', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    const calls: Array<{ rule: string; transition: 'new' | 'promoted' }> = []
    await runStuckTaskDetector({
      db: h.db,
      now: () => T0,
      onAlert: (row, transition) => calls.push({ rule: row.rule, transition }),
    })
    expect(calls).toEqual([{ rule: 'S4', transition: 'new' }])
  })

  test('ownedRules guard: stuck detector does not resolve invariant rows', async () => {
    // Seed a fake R1 row to simulate PR-D having found a violation.
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    await h.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId: h.taskId,
      rule: 'R1',
      severity: 'warning',
      detail: '{"rule":"R1"}',
      detectedAt: T0 - 60 * MIN_MS,
      resolvedAt: null,
    })
    // Stuck detector runs — should add S4, NOT touch the R1 row.
    await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const rows = await h.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, h.taskId))
    const r1 = rows.find((r) => r.rule === 'R1')!
    expect(r1.resolvedAt).toBeNull() // ← still open
  })
})
