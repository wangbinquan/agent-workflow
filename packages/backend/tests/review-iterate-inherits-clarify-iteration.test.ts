// Regression: when a review's upstream agent has a clarify-rerun row
// (clarifyIteration=N>0, retryIndex=0, done) as its freshest node_run,
// submitReviewDecision('iterated' | 'rejected') must
//   (a) treat that clarify-rerun as `latest` (not the older retryIndex-only
//       winner), and
//   (b) mint the new pending node_run with `clarifyIteration=N` inherited
//       AND `retryIndex = latest.retryIndex + 1`.
//
// Without (b) the new pending row defaults to clarifyIteration=0; the
// scheduler's `isFresherNodeRun` (clarifyIteration first) then ranks the
// prior clarify-rerun done row above the new pending row, marks the agent
// "completed", and dispatchReviewNode immediately reads the stale upstream
// output to mint v(n+1). Symptom from the wild (task 01KS1N8WVZWE8FTR4K9WSETRNW
// "贪吃蛇"): every iterate decision instantly produced a new doc_version with
// byte-identical body and `node_runs.started_at IS NULL`, i.e. the agent
// never re-executed — yet the version chip bumped.
//
// Without (a) the supersede-marker would land on the wrong row (the older
// retry-index winner) and `nextRetryIndex` would be computed off the wrong
// baseline, breaking the Prompt-tab attempts switcher's lineage.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
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
import { submitReviewDecision } from '../src/services/review'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Fixture {
  db: DbClient
  appHome: string
  worktree: string
  taskId: string
  reviewNodeRunId: string
  staleRunId: string
  clarifyRunId: string
  pendingDocVersionId: string
}

async function buildFixture(opts: {
  db: DbClient
  appHome: string
  worktree: string
}): Promise<Fixture> {
  const { db, appHome, worktree } = opts

  const agentId = ulid()
  await db.insert(agentsTable).values({
    id: agentId,
    name: 'doc',
    description: '',
    outputs: JSON.stringify(['design']),
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
        inputSource: { nodeId: 'doc', portName: 'design' },
        rerunnableOnIterate: ['doc'],
        rerunnableOnReject: ['doc'],
      } as unknown as WorkflowNode,
    ],
    edges: [],
  }

  const workflowId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
  })

  const taskId = ulid()
  await db.insert(tasks).values({
    name: 'iterate-clarify-rerun-task',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: worktree,
    worktreePath: worktree,
    baseBranch: 'main',
    branch: 'agent-workflow/' + taskId,
    status: 'awaiting_review',
    inputs: '{}',
    startedAt: Date.now(),
  })

  // Stale process-retry row: ran BEFORE the clarify session opened. Higher
  // retryIndex. RFC-074 PR-C: freshness is pure id-order, so the ids are CAUSAL
  // — the clarify rerun (minted later) gets the larger id. (Plain ulid() is not
  // monotonic within a millisecond, so we pin explicit ordered ids.)
  const staleRunId = '01A_STALE'
  await db.insert(nodeRuns).values({
    id: staleRunId,
    taskId,
    nodeId: 'doc',
    iteration: 0,
    retryIndex: 1,
    status: 'done',
    startedAt: Date.now() - 2000,
    finishedAt: Date.now() - 1500,
    preSnapshot: 'stale-snapshot-sha',
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: staleRunId,
    portName: 'design',
    content: '# stale body — must NOT seed the new doc_version',
  })

  // Clarify-driven rerun row: minted by submitClarifyAnswers at retryIndex=0,
  // later than the stale row (larger id); this is the row whose output the
  // current pending doc_version (v1) was created from.
  const clarifyRunId = '01B_CLARIFY'
  await db.insert(nodeRuns).values({
    id: clarifyRunId,
    taskId,
    nodeId: 'doc',
    iteration: 0,
    retryIndex: 0,
    status: 'done',
    startedAt: Date.now() - 1000,
    finishedAt: Date.now() - 500,
    preSnapshot: 'clarify-snapshot-sha',
  })
  await db.insert(nodeRunOutputs).values({
    nodeRunId: clarifyRunId,
    portName: 'design',
    content: '# clarify-rerun body — what the user just iterated on',
  })

  // Review node_run sitting in awaiting_review.
  const reviewNodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: reviewNodeRunId,
    taskId,
    nodeId: 'rev_1',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    status: 'awaiting_review',
    startedAt: Date.now() - 200,
  })

  // Pending doc_version v1 anchored on the review run.
  const pendingDocVersionId = ulid()
  const bodyRel = `runs/${taskId}/review/rev_1/design/v1.md`
  const bodyAbs = join(appHome, bodyRel)
  mkdirSync(join(appHome, `runs/${taskId}/review/rev_1/design`), { recursive: true })
  writeFileSync(bodyAbs, '# clarify-rerun body — what the user just iterated on', 'utf8')
  await db.insert(docVersions).values({
    id: pendingDocVersionId,
    taskId,
    reviewNodeId: 'rev_1',
    reviewNodeRunId,
    sourceNodeId: 'doc',
    sourcePortName: 'design',
    versionIndex: 1,
    reviewIteration: 0,
    bodyPath: bodyRel,
    commentsJson: '[]',
    decision: 'pending',
    createdAt: Date.now() - 100,
  })

  return {
    db,
    appHome,
    worktree,
    taskId,
    reviewNodeRunId,
    staleRunId,
    clarifyRunId,
    pendingDocVersionId,
  }
}

describe('submitReviewDecision iterate/reject inherits clarifyIteration from latest upstream', () => {
  let db: DbClient
  let appHome: string
  let worktree: string

  beforeEach(() => {
    const tmp = mkdtempSync(join(tmpdir(), 'aw-rev-iter-ci-'))
    appHome = join(tmp, 'appHome')
    worktree = join(tmp, 'worktree')
    mkdirSync(appHome, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    db = createInMemoryDb(MIGRATIONS)
  })

  afterEach(() => {
    rmSync(appHome, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })

  test('iterate: new pending row carries clarifyIteration=N and retry_index=latest+1; supersede marker lands on the clarify-rerun row', async () => {
    const f = await buildFixture({ db, appHome, worktree })

    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: f.reviewNodeRunId,
      decision: 'iterated',
      expectedReviewIteration: 0,
    })

    const upRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, f.taskId), eq(nodeRuns.nodeId, 'doc')))

    // Three rows now: stale (untouched), clarify-rerun (now canceled with
    // supersede marker), fresh pending.
    expect(upRuns.length).toBe(3)
    const stale = upRuns.find((r) => r.id === f.staleRunId)!
    const clarify = upRuns.find((r) => r.id === f.clarifyRunId)!
    const fresh = upRuns.find((r) => r.id !== f.staleRunId && r.id !== f.clarifyRunId)!

    // (a) latest selection — the clarify-rerun row is the one canceled.
    // Whyfo: if dispatchReviewDecision still used `desc(retryIndex)` for
    // `latest`, the supersede marker would land on the stale retryIndex=1
    // row instead — breaking the Prompt-tab attempts lineage AND inheriting
    // the wrong preSnapshot into the fresh row.
    expect(stale.status).toBe('done') // untouched
    expect(stale.errorMessage).toBeNull()
    expect(clarify.status).toBe('canceled')
    expect(clarify.errorMessage).toContain('superseded-by-review-iterated')

    // (b) the new pending row inherits clarifyIteration=1 so isFresherNodeRun
    // ranks it above the prior clarify-rerun done row. Without this the
    // scheduler skips agent execution and dispatchReviewNode immediately
    // mints v2 from stale output.
    expect(fresh.status).toBe('pending')
    // retry_index = latest(clarify-rerun).retryIndex + 1 = 0 + 1 = 1.
    expect(fresh.retryIndex).toBe(1)
    expect(fresh.iteration).toBe(0)
    expect(fresh.parentNodeRunId).toBeNull()
    expect(fresh.preSnapshot).toBe('clarify-snapshot-sha') // inherited from clarify-rerun, not stale
    // Agent has not run yet — started_at must still be null.
    expect(fresh.startedAt).toBeNull()

    // No new doc_version should have been minted by the iterate dispatch
    // itself — v2 is created later by dispatchReviewNode AFTER the scheduler
    // runs the fresh pending row. (This was the bug shape: v2 appearing
    // here with a NULL started_at on the fresh upstream row.)
    const dvs = await db.select().from(docVersions).where(eq(docVersions.taskId, f.taskId))
    expect(dvs.length).toBe(1)
    expect(dvs[0]!.id).toBe(f.pendingDocVersionId)
    expect(dvs[0]!.decision).toBe('iterated')
  })

  test('reject: same lineage — supersede marker lands on the clarify-rerun row and new pending inherits clarifyIteration=1', async () => {
    const f = await buildFixture({ db, appHome, worktree })

    await submitReviewDecision({
      db,
      appHome,
      nodeRunId: f.reviewNodeRunId,
      decision: 'rejected',
      rejectReason: 'wrong direction',
      expectedReviewIteration: 0,
    })

    const upRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, f.taskId), eq(nodeRuns.nodeId, 'doc')))

    const stale = upRuns.find((r) => r.id === f.staleRunId)!
    const clarify = upRuns.find((r) => r.id === f.clarifyRunId)!
    const fresh = upRuns.find((r) => r.id !== f.staleRunId && r.id !== f.clarifyRunId)!

    expect(stale.status).toBe('done')
    expect(clarify.status).toBe('canceled')
    expect(clarify.errorMessage).toContain('superseded-by-review-rejected')
    expect(fresh.status).toBe('pending')
    expect(fresh.retryIndex).toBe(1)
  })
})
