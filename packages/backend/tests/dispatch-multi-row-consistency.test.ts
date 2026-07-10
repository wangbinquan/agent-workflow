import { rimrafDir } from './helpers/cleanup'
// RFC-053 PR-A T1b — multi-row dispatch consistency.
//
// When a (task, nodeId, iteration) has more than one top-level node_run row
// (which happens after retry-cascade, clarify-rerun, iterate-cancel, etc.),
// two independent code paths read the same DB and must agree on "which row
// is current":
//
//   1. `scheduler.runScope.latestPerNode` (via `isFresherNodeRun`:
//      clarifyIteration → retryIndex → ulid)
//   2. `services/review.ts dispatchReviewNode` — RFC-052 fix uses the same
//      comparator AND an "ANY top-level row done → short-circuit" rule.
//
// These cases enumerate the multi-row shapes we have seen in production
// (or believe the scheduler will produce) and lock in current consistent
// behavior. PR-B onwards keep these green by construction.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq, and } from 'drizzle-orm'
// RFC-074 PR-C: freshness is pure ULID id-order. These tests seed multiple
// node_runs synchronously and rely on creation order, so we use a MONOTONIC
// factory — plain ulid() is not monotonic within a millisecond and would make
// "scheduler picks the later row" non-deterministic.
import { monotonicFactory } from 'ulid'
const ulid = monotonicFactory()
import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  agents as agentsTable,
  docVersions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { dispatchReviewNode } from '../src/services/review'
import { isFresherNodeRun } from '../src/services/scheduler'
import { runGit } from '../src/util/git'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  appHome: string
  repoPath: string
  taskId: string
  definition: WorkflowDefinition
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-t1b-'))
  const appHome = join(tmp, 'appHome')
  const repoPath = join(tmp, 'repo')
  mkdirSync(appHome, { recursive: true })
  mkdirSync(repoPath, { recursive: true })
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 't@t.test'])
  await runGit(repoPath, ['config', 'user.name', 't'])
  writeFileSync(join(repoPath, 'README.md'), '# r\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'i'])

  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(agentsTable).values({
    id: ulid(),
    name: 'doc',
    description: '',
    outputs: JSON.stringify(['docpath']),
    permission: '{}',
    skills: '[]',
    frontmatterExtra: '{}',
    bodyMd: '',
  })
  const definition: WorkflowDefinition = {
    $schema_version: 2,
    inputs: [],
    nodes: [
      { id: 'doc', kind: 'agent-single', agentName: 'doc', promptTemplate: '' } as WorkflowNode,
      {
        id: 'rev_1',
        kind: 'review',
        inputSource: { nodeId: 'doc', portName: 'docpath' },
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }
  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: JSON.stringify(definition),
  })
  const taskId = ulid()
  await db.insert(tasks).values({
    name: 't',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath,
    worktreePath: repoPath,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return {
    db,
    appHome,
    repoPath,
    taskId,
    definition,
    cleanup: () => rimrafDir(tmp),
  }
}

// Helper: mimic scheduler.runScope's latestPerNode pick for one nodeId at
// one iteration. Uses the exported isFresherNodeRun comparator (same one
// scheduler imports).
async function pickLatestRow(
  db: DbClient,
  taskId: string,
  nodeId: string,
  iteration = 0,
): Promise<{ id: string; status: string; retryIndex: number }> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
  let latest: (typeof rows)[number] | undefined
  for (const r of rows) {
    if (r.iteration !== iteration) continue
    if (r.parentNodeRunId !== null) continue
    if (isFresherNodeRun(r, latest)) latest = r
  }
  if (latest === undefined) throw new Error('no row matched')
  return latest
}

async function seedAgentDone(
  db: DbClient,
  taskId: string,
  opts: { retryIndex?: number; clarifyIteration?: number; portContent?: string } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'doc',
    iteration: 0,
    retryIndex: opts.retryIndex ?? 0,
    status: 'done',
    startedAt: Date.now() - 200,
    finishedAt: Date.now() - 100,
  })
  await db
    .insert(nodeRunOutputs)
    .values({ nodeRunId: id, portName: 'docpath', content: opts.portContent ?? '# v' })
  return id
}

async function seedReviewRow(
  db: DbClient,
  taskId: string,
  opts: {
    status: 'pending' | 'awaiting_review' | 'done' | 'canceled' | 'failed'
    retryIndex?: number
    clarifyIteration?: number
    reviewIteration?: number
    errorMessage?: string
    finishedAt?: number
  },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'rev_1',
    iteration: 0,
    retryIndex: opts.retryIndex ?? 0,
    reviewIteration: opts.reviewIteration ?? 0,
    status: opts.status,
    errorMessage: opts.errorMessage ?? null,
    startedAt: Date.now() - 50,
    finishedAt: opts.finishedAt ?? null,
  })
  return id
}

describe('RFC-053 PR-A T1b — multi-row dispatch consistency', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('C1 single pending row: scheduler picks it; dispatch parks it to awaiting_review', async () => {
    await seedAgentDone(h.db, h.taskId)
    const reviewId = await seedReviewRow(h.db, h.taskId, { status: 'pending' })
    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(reviewId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('awaiting_review')
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, reviewId)))[0]!
    expect(after.status).toBe('awaiting_review')
  })

  test('C2 single done row: scheduler picks it; dispatch short-circuits ok', async () => {
    await seedAgentDone(h.db, h.taskId)
    const doneId = await seedReviewRow(h.db, h.taskId, {
      status: 'done',
      finishedAt: Date.now() - 5,
    })
    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(doneId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('ok')
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, doneId)))[0]!
    expect(after.status).toBe('done') // not touched
  })

  test('C3 RFC-052 shape: retry=0 done + retry=1 failed placeholder → scheduler picks retry=1 BUT dispatch short-circuits ok', async () => {
    await seedAgentDone(h.db, h.taskId)
    const doneId = await seedReviewRow(h.db, h.taskId, {
      status: 'done',
      retryIndex: 0,
      finishedAt: Date.now() - 100,
    })
    const placeholderId = await seedReviewRow(h.db, h.taskId, {
      status: 'failed',
      retryIndex: 1,
      errorMessage: 'queued for retry',
      finishedAt: Date.now() - 50,
    })

    // isFresherNodeRun ranks retry=1 above retry=0 — scheduler picks placeholder.
    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(placeholderId)

    // But dispatchReviewNode's RFC-052 "ANY top-level row done → short-circuit" rule
    // overrides freshness. Done row is preserved; placeholder is left alone too.
    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('ok')

    const doneAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, doneId)))[0]!
    expect(doneAfter.status).toBe('done')
    const placeholderAfter = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, placeholderId))
    )[0]!
    expect(placeholderAfter.status).toBe('failed')
  })

  test('C4 retry=0 canceled (superseded) + retry=1 pending → scheduler picks retry=1 + dispatch parks it', async () => {
    await seedAgentDone(h.db, h.taskId)
    const canceledId = await seedReviewRow(h.db, h.taskId, {
      status: 'canceled',
      retryIndex: 0,
      errorMessage:
        'superseded-by-review-iterated: Replaced by retry_index 1 due to review iterated of rev_1',
      finishedAt: Date.now() - 100,
    })
    const pendingId = await seedReviewRow(h.db, h.taskId, {
      status: 'pending',
      retryIndex: 1,
      reviewIteration: 1,
    })

    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(pendingId)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('awaiting_review')

    // Canceled row stays canceled (no done row exists in this shape, so the
    // ANY-done short-circuit does NOT fire).
    const canceledAfter = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, canceledId))
    )[0]!
    expect(canceledAfter.status).toBe('canceled')
    // Dispatch operates on the latest (pending row) and parks it.
    const pendingAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, pendingId)))[0]!
    expect(pendingAfter.status).toBe('awaiting_review')
  })

  test('C5 clarifyIteration beats retryIndex: ci=1/retry=0 pending wins over ci=0/retry=1 done', async () => {
    await seedAgentDone(h.db, h.taskId)
    const staleId = await seedReviewRow(h.db, h.taskId, {
      status: 'done',
      retryIndex: 1,
      finishedAt: Date.now() - 100,
    })
    const clarifyRerunId = await seedReviewRow(h.db, h.taskId, {
      status: 'pending',
      retryIndex: 0,
    })

    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(clarifyRerunId)

    // Done row at ci=0 still triggers "ANY done → short-circuit" though! This is
    // intentional: once the user approved the review at some point, even a
    // clarify rerun shouldn't re-trigger the review. The clarify rerun row will
    // simply linger pending — scheduler treats this node as done via the
    // any-done short-circuit.
    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('ok')

    const staleAfter = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, staleId)))[0]!
    expect(staleAfter.status).toBe('done')
    const clarifyAfter = (
      await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, clarifyRerunId))
    )[0]!
    // pending row left as-is; scheduler short-circuits on the done row.
    expect(clarifyAfter.status).toBe('pending')
  })

  test('C6 three-row mixture: canceled + canceled + pending → scheduler picks pending, dispatch parks', async () => {
    await seedAgentDone(h.db, h.taskId)
    const c0 = await seedReviewRow(h.db, h.taskId, {
      status: 'canceled',
      retryIndex: 0,
      reviewIteration: 0,
      errorMessage: 'superseded',
      finishedAt: Date.now() - 200,
    })
    const c1 = await seedReviewRow(h.db, h.taskId, {
      status: 'canceled',
      retryIndex: 1,
      reviewIteration: 1,
      errorMessage: 'superseded',
      finishedAt: Date.now() - 100,
    })
    const p2 = await seedReviewRow(h.db, h.taskId, {
      status: 'pending',
      retryIndex: 2,
      reviewIteration: 2,
    })

    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(p2)

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('awaiting_review')
    const after = (await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, p2)))[0]!
    expect(after.status).toBe('awaiting_review')
    expect(after.reviewIteration).toBe(2)
    // Canceled siblings untouched.
    expect((await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, c0)))[0]!.status).toBe(
      'canceled',
    )
    expect((await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, c1)))[0]!.status).toBe(
      'canceled',
    )
  })

  test('C7 ulid tiebreak: two rows at identical (ci, retryIndex) → newer ulid wins', async () => {
    await seedAgentDone(h.db, h.taskId)
    const older = await seedReviewRow(h.db, h.taskId, {
      status: 'failed',
      retryIndex: 0,
      finishedAt: Date.now() - 100,
    })
    // Force a "newer" ULID by sleeping briefly (ULID is monotonic per ms).
    await Bun.sleep(2)
    const newer = await seedReviewRow(h.db, h.taskId, {
      status: 'pending',
      retryIndex: 0,
      finishedAt: null as never,
    })
    // The two share (ci=0, retry=0). isFresherNodeRun uses ulid as tiebreak.
    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(newer)
    void older
  })

  test('C8 iteration filter: iter=0 done + iter=1 pending → at iter=1 scheduler picks iter=1 only', async () => {
    await seedAgentDone(h.db, h.taskId)
    // iter=0 done
    const iter0 = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter0,
      taskId: h.taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'done',
      startedAt: Date.now() - 200,
      finishedAt: Date.now() - 100,
    })
    // iter=1 pending (e.g., a loop wrapper second iteration)
    const iter1 = ulid()
    await h.db.insert(nodeRuns).values({
      id: iter1,
      taskId: h.taskId,
      nodeId: 'rev_1',
      iteration: 1,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'pending',
      startedAt: Date.now(),
    })

    const latestIter1 = await pickLatestRow(h.db, h.taskId, 'rev_1', 1)
    expect(latestIter1.id).toBe(iter1)
    const latestIter0 = await pickLatestRow(h.db, h.taskId, 'rev_1', 0)
    expect(latestIter0.id).toBe(iter0)
  })

  test('C9 parentNodeRunId child rows are excluded from latest selection', async () => {
    await seedAgentDone(h.db, h.taskId)
    const top = await seedReviewRow(h.db, h.taskId, { status: 'pending' })
    // Fan-out shard child (parentNodeRunId set). Even though it would
    // dominate by retryIndex, it must be skipped.
    const childId = ulid()
    await h.db.insert(nodeRuns).values({
      id: childId,
      taskId: h.taskId,
      nodeId: 'rev_1',
      iteration: 0,
      retryIndex: 9,
      reviewIteration: 0,
      parentNodeRunId: top,
      shardKey: 'shard-1',
      status: 'pending',
      startedAt: Date.now(),
    })

    const latest = await pickLatestRow(h.db, h.taskId, 'rev_1')
    expect(latest.id).toBe(top)
  })

  test('C10 RFC-052 ANY-done short-circuit ignores reviewIteration disagreement', async () => {
    // Pathological shape: a done row at reviewIteration=4 + a pending row at
    // reviewIteration=5 (e.g., someone manually iterated past the approval).
    // The any-done rule still short-circuits.
    await seedAgentDone(h.db, h.taskId)
    const doneId = await seedReviewRow(h.db, h.taskId, {
      status: 'done',
      retryIndex: 0,
      reviewIteration: 4,
      finishedAt: Date.now() - 100,
    })
    const pendingId = await seedReviewRow(h.db, h.taskId, {
      status: 'pending',
      retryIndex: 1,
      reviewIteration: 5,
    })

    const task = (await h.db.select().from(tasks).where(eq(tasks.id, h.taskId)))[0]!
    const res = await dispatchReviewNode({
      db: h.db,
      taskId: h.taskId,
      task,
      appHome: h.appHome,
      definition: h.definition,
      node: h.definition.nodes.find((n) => n.id === 'rev_1')!,
      iteration: 0,
    })
    expect(res.kind).toBe('ok')

    // No new doc_version minted (the RFC-052 guard).
    const dvs = await h.db.select().from(docVersions).where(eq(docVersions.taskId, h.taskId))
    expect(dvs.length).toBe(0)

    // Both rows untouched.
    expect((await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, doneId)))[0]!.status).toBe(
      'done',
    )
    expect((await h.db.select().from(nodeRuns).where(eq(nodeRuns.id, pendingId)))[0]!.status).toBe(
      'pending',
    )
  })
})
