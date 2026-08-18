// RFC-311 PR-1 — inbox badge count(*) rewrites, locked to the list pipelines.
//
// The shell polls three pending-count endpoints every 15s per open tab. Their
// old implementations materialized whole tables (reviews: node_runs + tasks +
// workflows complete; clarify: clarify_rounds complete plus two full tasks
// scans) just to produce one number — the top steady-state load in the RFC-311
// audit (L1-1..L1-5). The rewrites are single indexed count(*) statements;
// THIS file is the oracle that pins them to the list+visibility pipeline they
// replaced: for every actor, count === filtered-list length. If either side
// drifts, the badge starts lying about the inbox.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '../src/auth/actor'
import { createInMemoryDb } from '../src/db/client'
import {
  clarifyRounds,
  docVersions,
  nodeRuns,
  taskCollaborators,
  tasks,
  users,
  workflows,
} from '../src/db/schema'
import {
  countAwaitingClarifyRounds,
  listClarifyRoundSummaries,
} from '../src/services/clarify/rounds'
import { countPendingReviews, listReviewSummaries } from '../src/services/review'
import { visibleTaskIdsOf } from '../src/services/taskAuthorization'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type Db = ReturnType<typeof createInMemoryDb>

function actor(id: string, role: 'admin' | 'user' = 'user'): Actor {
  return buildActor({
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
  })
}

async function seed(db: Db): Promise<void> {
  const now = 1_788_278_400_000
  await db.insert(users).values(
    ['admin', 'alice', 'bob', 'carol'].map((id) => ({
      id,
      username: id,
      displayName: id,
      role: id === 'admin' ? ('admin' as const) : ('user' as const),
      createdAt: now,
      updatedAt: now,
    })),
  )
  await db.insert(workflows).values({
    id: 'wf1',
    name: 'wf',
    definition: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
  })
}

async function addTask(
  db: Db,
  id: string,
  ownerUserId: string,
  status: 'running' | 'awaiting_review' | 'awaiting_human' | 'done' | 'canceled',
  opts: { workflowId?: string } = {},
): Promise<void> {
  await db.insert(tasks).values({
    id,
    name: id,
    workflowId: opts.workflowId ?? 'wf1',
    workflowSnapshot: JSON.stringify({ nodes: [], edges: [], inputs: [] }),
    repoPath: '/tmp/never-read',
    worktreePath: '/tmp/never-read',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status,
    inputs: '{}',
    startedAt: 100,
    ownerUserId,
  })
}

async function addReviewRun(
  db: Db,
  taskId: string,
  runId: string,
  status: 'awaiting_review' | 'running' | 'done',
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: runId,
    taskId,
    nodeId: 'rev',
    status,
    retryIndex: 0,
    iteration: 0,
    reviewIteration: 0,
    startedAt: 100,
  })
}

async function addDocVersion(
  db: Db,
  taskId: string,
  runId: string,
  versionIndex: number,
  decision: 'pending' | 'approved' | 'rejected',
  port = 'doc',
): Promise<void> {
  await db.insert(docVersions).values({
    id: ulid(),
    taskId,
    reviewNodeId: 'rev',
    reviewNodeRunId: runId,
    sourceNodeId: 'src',
    sourcePortName: port,
    versionIndex,
    reviewIteration: 0,
    bodyPath: 'doc_versions/never-read.md',
    decision,
  })
}

/** The exact pipeline the badge endpoint used before RFC-311. */
async function legacyReviewBadge(db: Db, who: Actor): Promise<number> {
  const pending = await listReviewSummaries(db, {
    status: 'pending',
    limit: Number.MAX_SAFE_INTEGER,
  })
  if (who.permissions.has('tasks:read:all')) return pending.length
  const visible = await visibleTaskIdsOf(db, who, [...new Set(pending.map((s) => s.taskId))])
  return pending.filter((s) => visible.has(s.taskId)).length
}

/** The exact pipeline the clarify badge used before RFC-311. */
async function legacyClarifyBadge(db: Db, who: Actor): Promise<number> {
  const pending = await listClarifyRoundSummaries(db, {
    status: 'awaiting_human',
    limit: Number.MAX_SAFE_INTEGER,
  })
  if (who.permissions.has('tasks:read:all')) return pending.length
  const visible = await visibleTaskIdsOf(db, who, [...new Set(pending.map((s) => s.taskId))])
  return pending.filter((s) => visible.has(s.taskId)).length
}

describe('RFC-311 — countPendingReviews oracle', () => {
  test('count(*) equals the legacy list+visibility pipeline for every actor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)

    // alice's live task: v1+v2 pending on the same (run, port) — only the
    // latest counts; a second port contributes one more.
    await addTask(db, 't-live', 'alice', 'awaiting_review')
    await addReviewRun(db, 't-live', 'run-live', 'awaiting_review')
    await addDocVersion(db, 't-live', 'run-live', 1, 'pending')
    await addDocVersion(db, 't-live', 'run-live', 2, 'pending')
    await addDocVersion(db, 't-live', 'run-live', 1, 'pending', 'other-port')
    await db.insert(taskCollaborators).values({
      taskId: 't-live',
      userId: 'carol',
      role: 'collaborator',
      addedBy: 'alice',
      addedAt: 1,
    })

    // Decided version → run no longer awaiting; must not count.
    await addTask(db, 't-decided', 'alice', 'running')
    await addReviewRun(db, 't-decided', 'run-decided', 'running')
    await addDocVersion(db, 't-decided', 'run-decided', 1, 'approved')

    // Pending doc on a terminal task → RFC-202 zombie filter drops it.
    await addTask(db, 't-done', 'alice', 'done')
    await addReviewRun(db, 't-done', 'run-done', 'awaiting_review')
    await addDocVersion(db, 't-done', 'run-done', 1, 'pending')

    // bob's own pending review — invisible to alice/carol.
    await addTask(db, 't-bob', 'bob', 'awaiting_review')
    await addReviewRun(db, 't-bob', 'run-bob', 'awaiting_review')
    await addDocVersion(db, 't-bob', 'run-bob', 1, 'pending')

    for (const who of [actor('admin', 'admin'), actor('alice'), actor('bob'), actor('carol')]) {
      expect(await countPendingReviews(db, who)).toBe(await legacyReviewBadge(db, who))
    }
    // Spot values so the oracle cannot go green by both sides being zero:
    // alice sees her 2 (latest per port); carol the same 2 as collaborator;
    // bob only his 1; admin all 3.
    expect(await countPendingReviews(db, actor('admin', 'admin'))).toBe(3)
    expect(await countPendingReviews(db, actor('alice'))).toBe(2)
    expect(await countPendingReviews(db, actor('carol'))).toBe(2)
    expect(await countPendingReviews(db, actor('bob'))).toBe(1)
    // No actor → no visibility condition (internal/count-all form).
    expect(await countPendingReviews(db)).toBe(3)
  })
})

describe('RFC-311 — countAwaitingClarifyRounds oracle', () => {
  async function addRound(
    db: Db,
    taskId: string,
    status: 'awaiting_human' | 'answered',
  ): Promise<void> {
    const runId = ulid()
    await db.insert(nodeRuns).values({
      id: runId,
      taskId,
      nodeId: 'ask',
      status: 'running',
      retryIndex: 0,
      iteration: 0,
      startedAt: 100,
    })
    await db.insert(clarifyRounds).values({
      id: ulid(),
      taskId,
      kind: 'self',
      askingNodeId: 'ask',
      askingNodeRunId: runId,
      intermediaryNodeId: 'ask',
      intermediaryNodeRunId: runId,
      questionsJson: '[]',
      status,
    })
  }

  test('count(*) equals the legacy list+visibility pipeline for every actor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await seed(db)

    await addTask(db, 'c-live', 'alice', 'awaiting_human')
    await addRound(db, 'c-live', 'awaiting_human')
    await addRound(db, 'c-live', 'answered') // answered → never counted

    await addTask(db, 'c-done', 'alice', 'canceled')
    await addRound(db, 'c-done', 'awaiting_human') // terminal task → dropped

    await addTask(db, 'c-bob', 'bob', 'awaiting_human')
    await addRound(db, 'c-bob', 'awaiting_human')

    for (const who of [actor('admin', 'admin'), actor('alice'), actor('bob'), actor('carol')]) {
      expect(await countAwaitingClarifyRounds(db, who)).toBe(await legacyClarifyBadge(db, who))
    }
    expect(await countAwaitingClarifyRounds(db, actor('admin', 'admin'))).toBe(2)
    expect(await countAwaitingClarifyRounds(db, actor('alice'))).toBe(1)
    expect(await countAwaitingClarifyRounds(db, actor('bob'))).toBe(1)
    expect(await countAwaitingClarifyRounds(db, actor('carol'))).toBe(0)
  })
})
