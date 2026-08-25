// RFC-041 — verify that completing a clarify session and submitting a
// review decision both enqueue a `memory_distill_jobs` row (best-effort,
// must not break the original decision path).

import { beforeEach, describe, expect, test } from 'bun:test'
import { insertClarifyRoundRaw } from './clarify-fixtures'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, memoryDistillJobs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedFixture(db: DbClient): Promise<{
  taskId: string
  workflowId: string
  intermediaryNodeRunId: string
  askingNodeRunId: string
  clarifySessionId: string
}> {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({
        schemaVersion: 1,
        name: 'wf',
        nodes: [
          { id: 'agent-1', kind: 'agent-single', agentName: 'codegen' },
          { id: 'clarify-1', kind: 'clarify' },
        ],
        edges: [],
      }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'fixture-task',
      workflowId: wfId,
      workflowSnapshot: JSON.stringify({
        schemaVersion: 1,
        nodes: [
          { id: 'agent-1', kind: 'agent-single', agentName: 'codegen' },
          { id: 'clarify-1', kind: 'clarify' },
        ],
      }),
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'awaiting_human',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  const sourceRunId = ulid()
  db.insert(nodeRuns)
    .values({
      id: sourceRunId,
      taskId,
      nodeId: 'agent-1',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      status: 'awaiting_human',
    })
    .run()
  const clarifyRunId = ulid()
  const sessionId = ulid()
  // RFC-217 T8：clarify_rounds 唯一数据源（原双写镜像退役为单播）。
  await insertClarifyRoundRaw(db, {
    id: sessionId,
    taskId,
    kind: 'self',
    askingNodeId: 'agent-1',
    askingNodeRunId: sourceRunId,
    intermediaryNodeId: 'clarify-1',
    intermediaryNodeRunId: clarifyRunId,
    targetConsumerNodeId: null,
    iteration: 0,
    loopIter: 0,
    questionsJson: JSON.stringify([{ id: 'q1', title: 'what?', kind: 'open' }]),
    status: 'awaiting_human',
  })
  return {
    taskId,
    workflowId: wfId,
    intermediaryNodeRunId: clarifyRunId,
    askingNodeRunId: sourceRunId,
    clarifySessionId: sessionId,
  }
}

describe('autoDispatchClarifyRound enqueues a distill job (RFC-132 缺口① 回归锁)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    resetBroadcastersForTests()
  })

  test('after a successful finalize, exactly one feedback-source-job row exists with the matching debounce key', async () => {
    const fx = await seedFixture(db)
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: fx.intermediaryNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: 'an answer',
        },
      ],
      actor: { userId: 'u1', role: 'owner' },
    }).catch(() => {
      /* a post-seal dispatch conflict must not hide the enqueue assertion below */
    })
    const jobs = db.select().from(memoryDistillJobs).all()
    expect(jobs.length).toBe(1)
    expect(jobs[0]!.sourceKind).toBe('clarify')
    expect(jobs[0]!.sourceEventId).toBe(fx.clarifySessionId)
    expect(jobs[0]!.debounceKey).toBe(`${fx.taskId}:clarify`)
    expect(jobs[0]!.taskId).toBe(fx.taskId)
  })

  test('clarify session row reflects the answered status (independent of the enqueue side-effect)', async () => {
    const fx = await seedFixture(db)
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: fx.intermediaryNodeRunId,
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [],
          selectedOptionLabels: [],
          customText: 'an answer',
        },
      ],
      actor: { userId: 'u1', role: 'owner' },
    }).catch(() => {
      /* seal commits before any post-seal dispatch conflict — the row assertions stand */
    })
    const row = db
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.id, fx.clarifySessionId))
      .all()[0]!
    expect(row.status).toBe('answered')
    expect(row.answeredAt).not.toBeNull()
  })
})

describe('source-code grep guard — review.ts enqueues distill for every decision path', () => {
  // RFC-326 (design §6.1): the decision path is one prepare / external /
  // transaction / after-commit sequence, so approve and reject/iterate share a
  // SINGLE post-commit enqueue instead of one per return branch. The guard now
  // pins that shape: exactly one call site, inside `submitReviewDecisionUnlocked`,
  // after the transaction (the `// ── after commit` marker) — and the behavioural
  // lock that both paths really enqueue lives in
  // rfc326-review-decision-transaction.test.ts (AC-17: approve / iterate / reject
  // each insert a memory_distill_jobs row after the COMMIT).
  test('enqueueDistillJob has exactly one call site, in the post-commit section of the decision', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'review.ts'),
      'utf8',
    )
    const matches = src.match(/enqueueDistillJob\(/g) ?? []
    expect(matches.length).toBe(1)
    const fnStart = src.indexOf('async function submitReviewDecisionUnlocked(')
    const afterCommit = src.indexOf('// ── after commit', fnStart)
    const callAt = src.indexOf('enqueueDistillJob(', fnStart)
    const fnEnd = src.indexOf('\nasync function planSingleDocApprove(', fnStart)
    expect(fnStart).toBeGreaterThan(0)
    expect(afterCommit).toBeGreaterThan(fnStart)
    expect(callAt).toBeGreaterThan(afterCommit)
    expect(callAt).toBeLessThan(fnEnd)
  })
})
