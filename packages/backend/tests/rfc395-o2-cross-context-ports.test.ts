// RFC-395 II-b package O2: real-provider proofs for moved queries, transaction binding and epoch-1 bytes.
import { expect, test } from 'bun:test'
import { ulid } from 'ulid'
import { TERMINAL_TASK_STATUSES, type TaskStatus } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import {
  composeRealtimeTaskFacts,
  composeSubjectTaskReferencePort,
  composeHumanGateTaskLockPort,
} from '@/modules/task-execution/composition'
import {
  composeReviewUpstreamAgents,
  composeRealtimeResourceAcl,
} from '@/modules/resource-catalog/composition'
import { composeTaskCollaborationReads } from '@/modules/collaboration/composition'
import { createTaskGateQueries } from '@/modules/task-execution/public/queries'
import { DrizzleRealtimeStore } from '@/modules/runtime-management/infrastructure/realtimeStore'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  patchTaskFixture,
  agentFixture,
  clarifyRoundFixture,
  nodeRunFixture,
  patchClarifyRoundFixture,
  type TaskFixtureSpec,
} from './helpers/model'
import { readStoredClarifyNavRows, readStoredClarifyRoundRows } from './helpers/model/storedRows'

async function seedTask(db: PersistenceDb, extra: Partial<TaskFixtureSpec> = {}) {
  const id = ulid()
  await taskFixture(db, {
    id,
    workflowId: 'workflow',
    workflowSnapshot: '{}',
    repoPath: '/repo',
    worktreePath: '/worktree',
    baseBranch: 'main',
    branch: 'task',
    status: 'running',
    inputs: '{}',
    startedAt: 1,
    ...extra,
  })
  return id
}

async function seedRound(
  db: PersistenceDb,
  taskId: string,
  runId: string,
  extra: { status?: 'awaiting_human' | 'answered' | 'canceled'; createdAt?: number } = {},
) {
  const id = ulid()
  await clarifyRoundFixture(db, {
    id,
    taskId,
    askingNodeId: 'ask',
    askingNodeRunId: runId,
    intermediaryNodeId: 'clarify',
    intermediaryNodeRunId: runId,
    kind: 'self',
    questions: ' [ ] ',
    answers: '{ "q" : "answer\\n" }',
    draftAnswers: '{ "q" : "draft" }',
    directive: 'continue',
    status: 'answered',
    createdAt: 10,
    ...extra,
  })
  return id
}

describeEachProvider('RFC-395 II-b O2 owner adapters', (harness) => {
  test('realtime member includes observer and every existing membership role; missing task stays null', async () => {
    const db = harness.db
    const { users, taskCollaborators } = tablesOf(db)
    const owner = ulid()
    await insertOne(db, users, {
      id: owner,
      username: owner,
      displayName: owner,
      role: 'user',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    })
    const taskId = await seedTask(db, { ownerUserId: owner })
    const facts = composeRealtimeTaskFacts(db)
    for (const role of ['owner', 'collaborator', 'observer'] as const) {
      const userId = ulid()
      await insertOne(db, users, {
        id: userId,
        username: userId,
        displayName: userId,
        role: 'user',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })
      await insertOne(db, taskCollaborators, { taskId, userId, role, addedBy: owner, addedAt: 1 })
      expect(await facts.taskAudience(taskId, userId)).toEqual({ ownerUserId: owner, member: true })
      expect(
        await createTaskGateQueries(db).visibleTaskIds({ userId, canReadAllTasks: false }, [
          taskId,
          'missing',
        ]),
      ).toEqual(new Set([taskId]))
    }
    expect(await facts.taskAudience(taskId, 'missing-member')).toEqual({
      ownerUserId: owner,
      member: false,
    })
    expect(await facts.taskAudience('missing-task', owner)).toBeNull()
    expect(
      await createTaskGateQueries(db).visibleTaskIds({ userId: owner, canReadAllTasks: true }, [
        taskId,
        'missing',
      ]),
    ).toEqual(new Set([taskId]))
  })

  test('realtime host workflow short-circuit does not call the resource adapter', async () => {
    let calls = 0
    const store = new DrizzleRealtimeStore(harness.db, composeRealtimeTaskFacts(harness.db), {
      async find() {
        calls++
        return null
      },
    })
    // The host prefix remains owned by the existing shared predicate.
    const { TASK_DEFINITION_HOSTS } = await import('@agent-workflow/shared')
    expect(await store.findResource('workflow', TASK_DEFINITION_HOSTS.agent.id)).toBeNull()
    expect(calls).toBe(0)
    expect(await composeRealtimeResourceAcl(harness.db).find('workgroup', 'missing')).toBeNull()
  })

  test('subject guards preserve each explicit subject across every status', async () => {
    const db = harness.db
    const sourceId = ulid()
    const statuses: TaskStatus[] = [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'awaiting_review',
      'awaiting_human',
    ]
    const expected: Record<'agent' | 'workflow' | 'workgroup', string[]> = {
      agent: [],
      workflow: [],
      workgroup: [],
    }
    for (const kind of ['agent', 'workflow', 'workgroup'] as const) {
      for (const status of statuses) {
        const id = await seedTask(db, {
          status,
          ...(kind === 'agent'
            ? { sourceAgentId: sourceId, sourceAgentName: 'source' }
            : kind === 'workgroup'
              ? { workgroupId: sourceId }
              : { workflowId: sourceId }),
        })
        if (!new Set<TaskStatus>(TERMINAL_TASK_STATUSES).has(status)) expected[kind].push(id)
      }
    }
    await seedTask(db, { sourceAgentId: null, workflowId: 'other', workgroupId: null })
    await harness.session.transaction(async (tx) => {
      const port = composeSubjectTaskReferencePort(tx)
      for (const kind of ['agent', 'workflow', 'workgroup'] as const) {
        expect([...(await port.nonTerminalTaskIds({ kind, sourceId }))].sort()).toEqual(
          [...expected[kind]].sort(),
        )
        expect(await port.nonTerminalTaskIds({ kind, sourceId: 'missing' })).toEqual([])
      }
    })
  })

  test('subject reads and human-gate lock use the caller transaction and roll back with it', async () => {
    const db = harness.db
    const sourceId = ulid()
    const taskId = await seedTask(db, {
      sourceAgentId: sourceId,
      sourceAgentName: 'source',
    })
    await expect(
      harness.session.transaction(async (tx) => {
        await composeHumanGateTaskLockPort(tx).lockTask(taskId)
        await patchTaskFixture(tx, { id: taskId }, { status: 'done' })
        expect(
          await composeSubjectTaskReferencePort(tx).nonTerminalTaskIds({ kind: 'agent', sourceId }),
        ).toEqual([])
        throw new Error('rollback-o2')
      }),
    ).rejects.toThrow('rollback-o2')
    await harness.session.transaction(async (tx) => {
      expect(
        await composeSubjectTaskReferencePort(tx).nonTerminalTaskIds({ kind: 'agent', sourceId }),
      ).toEqual([taskId])
    })
  })

  test('review profiles preserve raw malformed and whitespace JSON for the existing tolerant consumers', async () => {
    const db = harness.db
    const id = ulid()
    await agentFixture(db, {
      id,
      name: id.toLowerCase(),
      outputs: '{broken',
      frontmatterExtra: ' { "outputKinds" : { "doc" : "path<md>", "skip": 7 } } ',
      syncOutputsOnIterate: true,
    })
    expect(await composeReviewUpstreamAgents(db).outputProfile(id)).toEqual({
      syncOutputsOnIterate: true,
      outputs: '{broken',
      frontmatterExtra: ' { "outputKinds" : { "doc" : "path<md>", "skip": 7 } } ',
    })
    expect(await composeReviewUpstreamAgents(db).outputProfile('missing')).toBeNull()
  })

  test('clarify archive keeps stored JSON bytes and the original section key', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = ulid()
    await nodeRunFixture(db, { id: runId, taskId, nodeId: 'clarify', status: 'awaiting_human' })
    await seedRound(db, taskId, runId)
    const archive = composeTaskCollaborationReads(db).archive
    const section = await archive.load(db, [taskId])
    expect(section.owner).toBe('C')
    expect(section.rows.clarify_rounds).toEqual(await readStoredClarifyRoundRows(db, taskId))
    expect((await archive.load(db, [])).rows.clarify_rounds).toEqual([])
  })

  test('designer park reads keep the clarify join multiplicity and append manual entries without deduplication', async () => {
    const db = harness.db
    const { taskQuestions } = tablesOf(db)
    const taskId = await seedTask(db)
    const runId = ulid()
    await nodeRunFixture(db, { id: runId, taskId, nodeId: 'clarify', status: 'done' })
    await seedRound(db, taskId, runId)
    await seedRound(db, taskId, runId)
    const stoppedRunId = ulid()
    await nodeRunFixture(db, { id: stoppedRunId, taskId, nodeId: 'stopped', status: 'done' })
    const stoppedRound = await seedRound(db, taskId, stoppedRunId)
    await patchClarifyRoundFixture(db, { id: stoppedRound }, { directive: 'stop' })
    const question = async (
      originNodeRunId: string,
      sourceKind: 'self' | 'manual',
      dispatchedAt: number,
      confirmation: 'open' | 'confirmed' = 'open',
      roleKind: 'designer' | 'questioner' = 'designer',
    ) => {
      await insertOne(db, taskQuestions, {
        id: ulid(),
        taskId,
        originNodeRunId,
        questionId: ulid(),
        questionTitle: 'question',
        sourceKind,
        roleKind,
        confirmation,
        dispatchedAt,
        triggerRunId: 'trigger',
        defaultTargetNodeId: 'default',
        overrideTargetNodeId: 'override',
      })
    }
    await question(runId, 'self', 1)
    await question(runId, 'manual', 2)
    await question('manual-without-round', 'manual', 3)
    await question(runId, 'self', 4, 'confirmed')
    await question(runId, 'self', 5, 'open', 'questioner')
    await question(stoppedRunId, 'self', 6)
    const entries = await composeTaskCollaborationReads(db).recovery.designerParkEntries(taskId)
    expect(entries).toHaveLength(6)
    expect(
      entries
        .slice(0, 4)
        .map((entry) => entry.dispatchedAt)
        .sort(),
    ).toEqual([1, 1, 2, 2])
    expect(
      entries
        .slice(4)
        .map((entry) => entry.dispatchedAt)
        .sort(),
    ).toEqual([2, 3])
    expect(
      entries.every(
        (entry) =>
          entry.triggerRunId === 'trigger' &&
          entry.defaultTargetNodeId === 'default' &&
          entry.overrideTargetNodeId === 'override',
      ),
    ).toBe(true)
  })

  test('clarify navigation keeps first-seen equal-createdAt rows, and replaces only on strictly newer timestamps', async () => {
    const db = harness.db
    const taskId = await seedTask(db)
    const runId = ulid()
    await nodeRunFixture(db, { id: runId, taskId, nodeId: 'clarify', status: 'awaiting_human' })
    await seedRound(db, taskId, runId, { status: 'answered' })
    await seedRound(db, taskId, runId, { status: 'canceled' })
    const before = await readStoredClarifyNavRows(db, taskId)
    const reads = composeTaskCollaborationReads(db)
    expect((await reads.clarifyNav.latestRoundStatusByRun(taskId)).get(runId)).toBe(
      before[0]!.status,
    )
    await seedRound(db, taskId, runId, { status: 'awaiting_human', createdAt: 11 })
    expect((await reads.clarifyNav.latestRoundStatusByRun(taskId)).get(runId)).toBe(
      'awaiting_human',
    )
    expect(await reads.recovery.hasOpenClarifyRound(taskId)).toBe(true)
    expect(await reads.recovery.hasOpenClarifyRound('missing')).toBe(false)
    expect(
      (await reads.recovery.lifecycleClarifyRounds([taskId])).map((round) => round.directive),
    ).toEqual(['continue', 'continue', 'continue'])
    expect(await reads.recovery.designerParkEntries('missing')).toEqual([])
  })
})
