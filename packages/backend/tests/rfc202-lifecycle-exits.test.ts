// RFC-202 — lifecycle exits & terminal sweep locks (T2/T3/T5/T6).
//
// WHY THIS FILE EXISTS: the 2026-07-16 UX audit found dead tasks' clarify /
// review gates lingering forever in the inbox (R8), no cancel exit from
// awaiting_* (P1 F-15), silently orphaned schedules on workflow deletion
// (P1 F-12), and write paths that accepted answers/decisions into terminal
// tasks. These tests lock the fixes end-to-end at the service layer. If a
// refactor turns any of these red, one of those audit P0/P1s is back.

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { insertClarifyRoundRaw } from './clarify-fixtures'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { ProviderNeutralDatabase } from '@/db/query'
import { describeEachProvider } from './helpers/eachProvider'
import {
  clarifyRounds,
  docVersions,
  nodeRuns,
  scheduledTasks,
  tasks,
  workflows,
} from '../src/db/schema'
import { sealOpenHumanGatesForTask } from '../src/services/terminalSweep'
import { createHumanGateTerminalSweepCommand } from '../src/modules/collaboration/infrastructure/humanGateTerminalSweep'
import { trySetTaskStatus } from '../src/services/lifecycle'
import { installTaskLifecycleAfterCommitTestPump } from './helpers/taskLifecycleCommittedEvents'
import { cancelViaEngine } from './helpers/cancelEngine'
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

type TaskStatusCol = (typeof tasks.$inferInsert)['status']
type NodeRunStatusCol = (typeof nodeRuns.$inferInsert)['status']

async function seedTask(
  db: ProviderNeutralDatabase,
  opts: { status?: TaskStatusCol; ownerUserId?: string | null } = {},
): Promise<{ taskId: string; workflowId: string }> {
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: `wf-${taskId.slice(-6)}`,
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
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
  return { taskId, workflowId }
}

async function seedRun(
  db: ProviderNeutralDatabase,
  taskId: string,
  nodeId: string,
  status: NodeRunStatusCol,
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status,
    retryIndex: 0,
    iteration: 0,
    preSnapshot: null,
    startedAt: Date.now(),
  })
  return id
}

async function seedClarifyRound(
  db: ProviderNeutralDatabase,
  taskId: string,
  kind: 'self' | 'cross',
  intermediaryNodeRunId: string,
  status: (typeof clarifyRounds.$inferInsert)['status'] = 'awaiting_human',
): Promise<string> {
  const id = ulid()
  await insertClarifyRoundRaw(db, {
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
  return id
}

describeEachProvider('RFC-202 T2 — terminal sweep', (provider) => {
  let db: ProviderNeutralDatabase
  let uninstallAfterCommitPump: (() => void) | null = null
  beforeEach(() => {
    db = provider.db
  })
  afterEach(async () => {
    uninstallAfterCommitPump?.()
  })

  test('mixed self+cross sweep: self→canceled, cross→abandoned (0031 CHECK safe), review parks canceled, one call', async () => {
    const { taskId } = await seedTask(db, { status: 'canceled' })
    const selfRun = await seedRun(db, taskId, 'clarify_x', 'awaiting_human')
    const crossRun = await seedRun(db, taskId, 'xclarify_x', 'awaiting_human')
    const reviewRun = await seedRun(db, taskId, 'rev_x', 'awaiting_review')
    await seedClarifyRound(db, taskId, 'self', selfRun)
    await seedClarifyRound(db, taskId, 'cross', crossRun)

    const sweep = createHumanGateTerminalSweepCommand(db)
    const result = await sealOpenHumanGatesForTask(sweep, taskId, 'task-canceled')
    expect(result.sealedSelfRounds).toBe(1)
    expect(result.abandonedCrossRounds).toBe(1)

    const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    expect(rounds.find((r) => r.kind === 'self')?.status).toBe('canceled')
    const cross = rounds.find((r) => r.kind === 'cross')
    expect(cross?.status).toBe('abandoned')
    expect(cross?.abandonedAt).not.toBeNull()

    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(runs.find((r) => r.id === selfRun)?.status).toBe('canceled')
    expect(runs.find((r) => r.id === crossRun)?.status).toBe('canceled')
    expect(runs.find((r) => r.id === reviewRun)?.status).toBe('canceled')
    expect(runs.find((r) => r.id === reviewRun)?.errorMessage).toBe('task-canceled')

    const sessions = await db
      .select()
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.kind, 'self')))

    expect(sessions[0]?.status).toBe('canceled')
    const xsessions = await db
      .select()
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.taskId, taskId), eq(clarifyRounds.kind, 'cross')))

    expect(xsessions[0]?.status).toBe('abandoned')

    // idempotent: second sweep is a no-op
    const again = await sealOpenHumanGatesForTask(sweep, taskId, 'task-canceled')
    expect(again.sealedSelfRounds).toBe(0)
    expect(again.abandonedCrossRounds).toBe(0)
    expect(again.canceledRuns.length).toBe(0)
  })

  test('terminal hook fires on done/canceled, not on failed; hook failure never blocks the transition', async () => {
    const calls: Array<{ taskId: string; to: string }> = []
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onTerminalTask(_db, taskId, to) {
        calls.push({ taskId, to })
        throw new Error('projector boom — must not block')
      },
    })
    const a = await seedTask(db, { status: 'running' })
    const won = await trySetTaskStatus({
      db,
      taskId: a.taskId,
      to: 'canceled',
      allowedFrom: ['running'],
      reason: 'test',
    })
    expect(won).toBe(true)
    const row = (await db.select().from(tasks).where(eq(tasks.id, a.taskId)))[0]!
    expect(row.status).toBe('canceled')
    expect(calls).toEqual([{ taskId: a.taskId, to: 'canceled' }])

    const b = await seedTask(db, { status: 'running' })
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

describeEachProvider('RFC-202 T3 — cancel from awaiting_*', (provider) => {
  let db: ProviderNeutralDatabase
  let uninstallAfterCommitPump: (() => void) | null = null
  // RFC-359 W4-B3：终态清扫只有一份异步实现（统一事务原语），提交后钩子里是 fire-and-forget；
  // 用例要断言清扫结果就得等它落定，而不是假设 SQLite 侧仍是同步完成。
  let terminalSweeps: Promise<unknown>[] = []
  beforeEach(() => {
    db = provider.db
    terminalSweeps = []
    uninstallAfterCommitPump = installTaskLifecycleAfterCommitTestPump(db, {
      onTerminalTask(hookDb, taskId) {
        terminalSweeps.push(
          sealOpenHumanGatesForTask(
            createHumanGateTerminalSweepCommand(hookDb),
            taskId,
            'task-canceled',
          ),
        )
      },
    })
  })
  afterEach(() => {
    uninstallAfterCommitPump?.()
  })

  test('awaiting_human task cancels via the fallback CAS and its open round is sealed', async () => {
    const { taskId } = await seedTask(db, { status: 'awaiting_human' })
    const run = await seedRun(db, taskId, 'clarify_x', 'awaiting_human')
    await seedClarifyRound(db, taskId, 'self', run)
    const out = await cancelViaEngine(db, taskId)
    expect(out.status).toBe('canceled')
    await Promise.all(terminalSweeps)
    const round = (
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    expect(round.status).toBe('canceled')
    const runRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, run)))[0]!
    expect(runRow.status).toBe('canceled')
    // RFC-328 cancels live node rows inside the task-status transaction. The
    // post-commit terminal sweep must still retain its transition-time cause
    // so historical clarify detail does not fall back to a generic banner.
    expect(runRow.errorMessage).toBe('task-canceled')
  })

  test('awaiting_review task cancels', async () => {
    const { taskId } = await seedTask(db, { status: 'awaiting_review' })
    await seedRun(db, taskId, 'rev_x', 'awaiting_review')
    const out = await cancelViaEngine(db, taskId)
    expect(out.status).toBe('canceled')
  })

  test('terminal task still 409s with the terminal wording', async () => {
    const { taskId } = await seedTask(db, { status: 'done' })
    await expect(cancelViaEngine(db, taskId)).rejects.toThrow(/already terminal/)
  })
})

describeEachProvider('RFC-202 T2-4 — write-path terminal guards', (provider) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = provider.db
  })

  test('sealRoundQuestions refuses answers into a done/canceled task BEFORE persisting', async () => {
    const { taskId } = await seedTask(db, { status: 'done' })
    const run = await seedRun(db, taskId, 'clarify_x', 'awaiting_human')
    await seedClarifyRound(db, taskId, 'self', run)
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
    const round = (
      await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
    )[0]!
    expect(round.status).toBe('awaiting_human')
    expect(round.answersJson ?? null).toBeNull()
  })

  test('submitReviewDecision refuses decisions on a canceled task', async () => {
    const { taskId } = await seedTask(db, { status: 'canceled' })
    const run = await seedRun(db, taskId, 'rev_x', 'awaiting_review')
    await db.insert(docVersions).values({
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

describeEachProvider('RFC-202 T6 — inbox terminal filtering (before pagination)', (provider) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = provider.db
  })

  test('clarify awaiting list drops terminal-task rounds even when zombies fill the page window', async () => {
    // 3 zombie rounds on a FAILED task (newer), 1 live round on a running task (older).
    const dead = await seedTask(db, { status: 'failed' })
    const live = await seedTask(db, { status: 'running' })
    const liveRun = await seedRun(db, live.taskId, 'clarify_x', 'awaiting_human')
    await seedClarifyRound(db, live.taskId, 'self', liveRun)
    await Bun.sleep(2) // ensure zombies sort newer (createdAt desc)
    for (let i = 0; i < 3; i++) {
      const r = await seedRun(db, dead.taskId, `clarify_z${i}`, 'awaiting_human')
      await seedClarifyRound(db, dead.taskId, 'self', r)
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
    const mk = async (status: TaskStatusCol) => {
      const t = await seedTask(db, { status })
      const run = await seedRun(db, t.taskId, 'rev_x', 'awaiting_review')
      await db.insert(docVersions).values({
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

      return t.taskId
    }
    const liveIds = [await mk('running'), await mk('awaiting_review'), await mk('running')]
    await mk('canceled')
    await mk('failed')
    const pending = await listReviewSummaries(db, { status: 'pending', limit: 100 })
    expect(pending.map((p) => p.taskId).sort()).toEqual([...liveIds].sort())
    // pagination window: limit 2 returns 2 LIVE rounds (zombies must not consume the window)
    const page = await listReviewSummaries(db, { status: 'pending', limit: 2 })
    expect(page.length).toBe(2)
    expect(page.every((p) => liveIds.includes(p.taskId))).toBe(true)
    expect(await countPendingReviews(db)).toBe(3)
  })
})

describeEachProvider('RFC-202 T5 — deleteWorkflow scheduled-task guard', (provider) => {
  let db: ProviderNeutralDatabase
  beforeEach(() => {
    db = provider.db
  })

  async function seedSchedule(workflowId: string, owner: string, name: string): Promise<string> {
    const id = ulid()
    await db.insert(scheduledTasks).values({
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
    const { workflowId } = await (async () => {
      const workflowId = ulid()
      await db.insert(workflows).values({
        id: workflowId,
        name: 'wf-guarded',
        definition: '{}',
        version: 1,
        ownerUserId: owner,
        visibility: 'public',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })

      return { workflowId }
    })()
    await seedSchedule(workflowId, owner, 'mine-daily')
    await seedSchedule(workflowId, 'user-other', 'their-private')

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
    expect((await db.select().from(workflows).where(eq(workflows.id, workflowId))).length).toBe(1)
  })

  test('no referencing schedules → delete proceeds', async () => {
    const workflowId = ulid()
    await db.insert(workflows).values({
      id: workflowId,
      name: 'wf-free',
      definition: '{}',
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })

    await deleteWorkflow(
      db,
      workflowId,
      { expectedVersion: 1, clientMutationId: ulid() },
      { kind: 'system', reason: 'test' },
    )
    expect((await db.select().from(workflows).where(eq(workflows.id, workflowId))).length).toBe(0)
  })
})
