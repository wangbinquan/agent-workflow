// RFC-202 — lifecycle exits & terminal sweep locks (T2/T3/T5/T6).
//
// WHY THIS FILE EXISTS: the 2026-07-16 UX audit found dead tasks' clarify /
// review gates lingering forever in the inbox (R8), no cancel exit from
// awaiting_* (P1 F-15), silently orphaned schedules on workflow deletion
// (P1 F-12), and write paths that accepted answers/decisions into terminal
// tasks. These tests lock the fixes end-to-end at the service layer. If a
// refactor turns any of these red, one of those audit P0/P1s is back.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  agents as agentsTable,
  clarifyRounds,
  clarifySessions,
  crossClarifySessions,
  docVersions,
  nodeRuns,
  scheduledTasks,
  tasks,
  workflows,
} from '../src/db/schema'
import { sealOpenHumanGatesForTask } from '../src/services/terminalSweep'
import { registerTerminalTaskHook, trySetTaskStatus } from '../src/services/lifecycle'
import { cancelTask } from '../src/services/task'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import {
  submitReviewDecision,
  listReviewSummaries,
  countPendingReviews,
} from '../src/services/review'
import { listClarifyRoundSummaries } from '../src/services/clarifyRounds'
import { deleteWorkflow, scheduledRowsReferencingWorkflow } from '../src/services/workflow'
import { ConflictError } from '../src/util/errors'
import { buildActor } from '../src/auth/actor'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

type TaskStatusCol = (typeof tasks.$inferInsert)['status']
type NodeRunStatusCol = (typeof nodeRuns.$inferInsert)['status']

function seedTask(
  db: DbClient,
  opts: { status?: TaskStatusCol; ownerUserId?: string | null } = {},
): { taskId: string; workflowId: string } {
  const workflowId = ulid()
  const taskId = ulid()
  db.insert(workflows)
    .values({
      id: workflowId,
      name: `wf-${taskId.slice(-6)}`,
      definition: '{}',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  db.insert(tasks)
    .values({
      id: taskId,
      name: `task-${taskId.slice(-6)}`,
      workflowId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: opts.status ?? 'running',
      inputs: '{}',
      startedAt: Date.now(),
      ownerUserId: opts.ownerUserId ?? null,
    })
    .run()
  return { taskId, workflowId }
}

function seedRun(db: DbClient, taskId: string, nodeId: string, status: NodeRunStatusCol): string {
  const id = ulid()
  db.insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId,
      status,
      retryIndex: 0,
      iteration: 0,
      preSnapshot: null,
      startedAt: Date.now(),
    })
    .run()
  return id
}

function seedClarifyRound(
  db: DbClient,
  taskId: string,
  kind: 'self' | 'cross',
  intermediaryNodeRunId: string,
  status: (typeof clarifyRounds.$inferInsert)['status'] = 'awaiting_human',
): string {
  const id = ulid()
  db.insert(clarifyRounds)
    .values({
      id,
      taskId,
      kind,
      askingNodeId: 'asker',
      askingNodeRunId: intermediaryNodeRunId,
      ...(kind === 'cross' ? { designerNodeId: 'designer' } : {}),
      intermediaryNodeId: kind === 'self' ? 'clarify_x' : 'xclarify_x',
      intermediaryNodeRunId,
      loopIter: 0,
      iteration: 0,
      questionsJson: JSON.stringify([{ id: 'q1', question: 'which?' }]),
      status,
      createdAt: Date.now(),
    })
    .run()
  return id
}

describe('RFC-202 T2 — terminal sweep', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    registerTerminalTaskHook(null)
  })

  test('mixed self+cross sweep: self→canceled, cross→abandoned (0031 CHECK safe), review parks canceled, one call', () => {
    const { taskId } = seedTask(db, { status: 'canceled' })
    const selfRun = seedRun(db, taskId, 'clarify_x', 'awaiting_human')
    const crossRun = seedRun(db, taskId, 'xclarify_x', 'awaiting_human')
    const reviewRun = seedRun(db, taskId, 'rev_x', 'awaiting_review')
    seedClarifyRound(db, taskId, 'self', selfRun)
    seedClarifyRound(db, taskId, 'cross', crossRun)
    db.insert(clarifySessions)
      .values({
        id: ulid(),
        taskId,
        sourceAgentNodeId: 'asker',
        sourceAgentNodeRunId: selfRun,
        sourceShardKey: null,
        clarifyNodeId: 'clarify_x',
        clarifyNodeRunId: selfRun,
        iterationIndex: 0,
        questionsJson: '[]',
        status: 'awaiting_human',
        createdAt: Date.now(),
      })
      .run()
    db.insert(crossClarifySessions)
      .values({
        id: ulid(),
        taskId,
        crossClarifyNodeId: 'xclarify_x',
        crossClarifyNodeRunId: crossRun,
        sourceQuestionerNodeId: 'asker',
        sourceQuestionerNodeRunId: crossRun,
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        iteration: 0,
        questionsJson: '[]',
        status: 'awaiting_human',
        createdAt: Date.now(),
      })
      .run()

    const result = sealOpenHumanGatesForTask(db, taskId, 'task-canceled')
    expect(result.sealedSelfRounds).toBe(1)
    expect(result.abandonedCrossRounds).toBe(1)

    const rounds = db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all()
    expect(rounds.find((r) => r.kind === 'self')?.status).toBe('canceled')
    const cross = rounds.find((r) => r.kind === 'cross')
    expect(cross?.status).toBe('abandoned')
    expect(cross?.abandonedAt).not.toBeNull()

    const runs = db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId)).all()
    expect(runs.find((r) => r.id === selfRun)?.status).toBe('canceled')
    expect(runs.find((r) => r.id === crossRun)?.status).toBe('canceled')
    expect(runs.find((r) => r.id === reviewRun)?.status).toBe('canceled')
    expect(runs.find((r) => r.id === reviewRun)?.errorMessage).toBe('task-canceled')

    const sessions = db
      .select()
      .from(clarifySessions)
      .where(eq(clarifySessions.taskId, taskId))
      .all()
    expect(sessions[0]?.status).toBe('canceled')
    const xsessions = db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.taskId, taskId))
      .all()
    expect(xsessions[0]?.status).toBe('abandoned')

    // idempotent: second sweep is a no-op
    const again = sealOpenHumanGatesForTask(db, taskId, 'task-canceled')
    expect(again.sealedSelfRounds).toBe(0)
    expect(again.abandonedCrossRounds).toBe(0)
    expect(again.canceledRuns.length).toBe(0)
  })

  test('terminal hook fires on done/canceled, not on failed; hook failure never blocks the transition', async () => {
    const calls: Array<{ taskId: string; to: string }> = []
    registerTerminalTaskHook((_db, taskId, to) => {
      calls.push({ taskId, to })
      throw new Error('hook boom — must not block')
    })
    const a = seedTask(db, { status: 'running' })
    const won = await trySetTaskStatus({
      db,
      taskId: a.taskId,
      to: 'canceled',
      allowedFrom: ['running'],
      reason: 'test',
    })
    expect(won).toBe(true)
    const row = db.select().from(tasks).where(eq(tasks.id, a.taskId)).all()[0]!
    expect(row.status).toBe('canceled')
    expect(calls).toEqual([{ taskId: a.taskId, to: 'canceled' }])

    const b = seedTask(db, { status: 'running' })
    await trySetTaskStatus({
      db,
      taskId: b.taskId,
      to: 'failed',
      allowedFrom: ['running'],
      reason: 'test',
    })
    // failed is revivable — no sweep
    expect(calls.length).toBe(1)
  })
})

describe('RFC-202 T3 — cancel from awaiting_*', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
    registerTerminalTaskHook((hookDb, taskId) =>
      sealOpenHumanGatesForTask(hookDb as DbClient, taskId, 'task-canceled'),
    )
  })
  afterEach(() => {
    registerTerminalTaskHook(null)
  })

  test('awaiting_human task cancels via the fallback CAS and its open round is sealed', async () => {
    const { taskId } = seedTask(db, { status: 'awaiting_human' })
    const run = seedRun(db, taskId, 'clarify_x', 'awaiting_human')
    seedClarifyRound(db, taskId, 'self', run)
    const out = await cancelTask(db, taskId)
    expect(out.status).toBe('canceled')
    const round = db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all()[0]!
    expect(round.status).toBe('canceled')
    const runRow = db.select().from(nodeRuns).where(eq(nodeRuns.id, run)).all()[0]!
    expect(runRow.status).toBe('canceled')
  })

  test('awaiting_review task cancels', async () => {
    const { taskId } = seedTask(db, { status: 'awaiting_review' })
    seedRun(db, taskId, 'rev_x', 'awaiting_review')
    const out = await cancelTask(db, taskId)
    expect(out.status).toBe('canceled')
  })

  test('terminal task still 409s with the terminal wording', async () => {
    const { taskId } = seedTask(db, { status: 'done' })
    await expect(cancelTask(db, taskId)).rejects.toThrow(/already terminal/)
  })
})

describe('RFC-202 T2-4 — write-path terminal guards', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('sealRoundQuestions refuses answers into a done/canceled task BEFORE persisting', async () => {
    const { taskId } = seedTask(db, { status: 'done' })
    const run = seedRun(db, taskId, 'clarify_x', 'awaiting_human')
    seedClarifyRound(db, taskId, 'self', run)
    await expect(
      sealRoundQuestions({
        db,
        originNodeRunId: run,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: 'x',
          },
        ],
      }),
    ).rejects.toMatchObject({ code: 'task-terminal' })
    // answers were NOT persisted
    const round = db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)).all()[0]!
    expect(round.status).toBe('awaiting_human')
    expect(round.answersJson ?? null).toBeNull()
  })

  test('submitReviewDecision refuses decisions on a canceled task', async () => {
    const { taskId } = seedTask(db, { status: 'canceled' })
    const run = seedRun(db, taskId, 'rev_x', 'awaiting_review')
    db.insert(docVersions)
      .values({
        id: ulid(),
        taskId,
        reviewNodeId: 'rev_x',
        reviewNodeRunId: run,
        sourceNodeId: 'src',
        sourcePortName: 'doc',
        reviewIteration: 0,
        versionIndex: 1,
        bodyPath: '/tmp/nonexistent.md',
        decision: 'pending',
        createdAt: Date.now(),
      })
      .run()
    await expect(
      submitReviewDecision({
        db,
        appHome: '/tmp',
        nodeRunId: run,
        decision: 'approved',
        expectedReviewIteration: 0,
      }),
    ).rejects.toMatchObject({ code: 'task-terminal' })
  })
})

describe('RFC-202 T6 — inbox terminal filtering (before pagination)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('clarify awaiting list drops terminal-task rounds even when zombies fill the page window', async () => {
    // 3 zombie rounds on a FAILED task (newer), 1 live round on a running task (older).
    const dead = seedTask(db, { status: 'failed' })
    const live = seedTask(db, { status: 'running' })
    const liveRun = seedRun(db, live.taskId, 'clarify_x', 'awaiting_human')
    seedClarifyRound(db, live.taskId, 'self', liveRun)
    await Bun.sleep(2) // ensure zombies sort newer (createdAt desc)
    for (let i = 0; i < 3; i++) {
      const r = seedRun(db, dead.taskId, `clarify_z${i}`, 'awaiting_human')
      seedClarifyRound(db, dead.taskId, 'self', r)
    }
    // limit=2 < zombie count: without filter-before-slice the live round vanishes.
    const page = await listClarifyRoundSummaries(db, { status: 'awaiting_human', limit: 2 })
    expect(page.length).toBe(1)
    expect(page[0]!.taskId).toBe(live.taskId)
    // explicit historical query stays unfiltered
    const all = await listClarifyRoundSummaries(db, { status: 'all', limit: 100 })
    expect(all.length).toBe(4)
  })

  test('review pending list + count drop terminal-task rounds; count is exact past the page size', async () => {
    const mk = (status: TaskStatusCol) => {
      const t = seedTask(db, { status })
      const run = seedRun(db, t.taskId, 'rev_x', 'awaiting_review')
      db.insert(docVersions)
        .values({
          id: ulid(),
          taskId: t.taskId,
          reviewNodeId: 'rev_x',
          reviewNodeRunId: run,
          sourceNodeId: 'src',
          sourcePortName: 'doc',
          reviewIteration: 0,
          versionIndex: 1,
          bodyPath: '/tmp/x.md',
          decision: 'pending',
          createdAt: Date.now(),
        })
        .run()
      return t.taskId
    }
    const liveIds = [mk('running'), mk('awaiting_review'), mk('running')]
    mk('canceled')
    mk('failed')
    const pending = await listReviewSummaries(db, { status: 'pending', limit: 100 })
    expect(pending.map((p) => p.taskId).sort()).toEqual([...liveIds].sort())
    // pagination window: limit 2 returns 2 LIVE rounds (zombies must not consume the window)
    const page = await listReviewSummaries(db, { status: 'pending', limit: 2 })
    expect(page.length).toBe(2)
    expect(page.every((p) => liveIds.includes(p.taskId))).toBe(true)
    expect(await countPendingReviews(db)).toBe(3)
  })
})

describe('RFC-202 T5 — deleteWorkflow scheduled-task guard', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  function seedSchedule(workflowId: string, owner: string, name: string): string {
    const id = ulid()
    db.insert(scheduledTasks)
      .values({
        id,
        name,
        ownerUserId: owner,
        enabled: true,
        scheduleSpec: JSON.stringify({ kind: 'interval', everyMinutes: 60 }),
        launchKind: 'workflow',
        launchPayload: JSON.stringify({ workflowId, name: 'x', inputs: {} }),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    return id
  }

  test('pure helper: matches workflow payloads, skips other kinds and malformed JSON', () => {
    const rows = [
      { id: 'a', launchKind: 'workflow', launchPayload: JSON.stringify({ workflowId: 'W1' }) },
      { id: 'b', launchKind: 'agent', launchPayload: JSON.stringify({ workflowId: 'W1' }) },
      { id: 'c', launchKind: 'workflow', launchPayload: '{not json' },
      { id: 'd', launchKind: 'workflow', launchPayload: JSON.stringify({ workflowId: 'W2' }) },
    ]
    expect(scheduledRowsReferencingWorkflow(rows, 'W1').map((r) => r.id)).toEqual(['a'])
  })

  test('delete is 409-blocked; details list only principal-visible schedules + hiddenCount', async () => {
    const owner = 'user-owner'
    const { workflowId } = (() => {
      const workflowId = ulid()
      db.insert(workflows)
        .values({
          id: workflowId,
          name: 'wf-guarded',
          definition: '{}',
          version: 1,
          ownerUserId: owner,
          visibility: 'public',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
        .run()
      return { workflowId }
    })()
    seedSchedule(workflowId, owner, 'mine-daily')
    seedSchedule(workflowId, 'user-other', 'their-private')

    const actor = buildActor({
      user: { id: owner, username: 'o', displayName: 'o', role: 'user', status: 'active' },
      source: 'session',
    })
    try {
      await deleteWorkflow(
        db,
        workflowId,
        { expectedVersion: 1, clientMutationId: ulid() },
        { kind: 'actor', actor },
      )
      throw new Error('expected ConflictError')
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictError)
      const ce = err as ConflictError
      expect(ce.code).toBe('workflow-scheduled-referenced')
      const details = ce.details as {
        scheduledCount: number
        visibleScheduled: Array<{ id: string; name: string }>
        hiddenCount: number
      }
      expect(details.scheduledCount).toBe(2)
      expect(details.visibleScheduled.map((v) => v.name)).toEqual(['mine-daily'])
      expect(details.hiddenCount).toBe(1)
    }
    // workflow still present
    expect(db.select().from(workflows).where(eq(workflows.id, workflowId)).all().length).toBe(1)
  })

  test('no referencing schedules → delete proceeds', async () => {
    const workflowId = ulid()
    db.insert(workflows)
      .values({
        id: workflowId,
        name: 'wf-free',
        definition: '{}',
        version: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    await deleteWorkflow(
      db,
      workflowId,
      { expectedVersion: 1, clientMutationId: ulid() },
      { kind: 'system', reason: 'test' },
    )
    expect(db.select().from(workflows).where(eq(workflows.id, workflowId)).all().length).toBe(0)
  })
})
