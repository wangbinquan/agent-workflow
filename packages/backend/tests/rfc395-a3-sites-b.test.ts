// RFC-395 II-a A3：双 provider 固定 G3–G7/G9/G12 的旧决定，尤其是 frame-less 与 framed 不同的历史。
import { expect, test } from 'bun:test'
import {
  resolveHandlerRun as legacyHandler,
  type ResolveHandlerInput,
} from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createNodeRunQueries,
  createRunSelectionReader,
  resolveHandlerRun,
} from '@/modules/task-execution/public/queries'
import { projectWorkgroupRunSelections } from '@/modules/task-execution/infrastructure/runSelection/workgroupProjection'
import { reselectRunInTx } from '@/modules/task-execution/public/participants'
import { withTaskExecutionWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleSchedulerCompletionPersistence } from '@/modules/task-execution/infrastructure/schedulerCompletionPersistence'
import { createCodeWorkspaceRead } from '@/modules/code-capability/infrastructure/codeWorkspaceRead'
import { taskNodeRunsProjection } from '@/modules/task-execution/infrastructure/taskRouteOperations'
import { freshestPriorRunWithOutput } from '@/modules/task-execution/composition/nodeMechanics'
import { planFrameBackfill } from '@/modules/task-execution/domain/legacyMigration/frameBackfill'
import { pickFreshestReviewRun } from '@/modules/collaboration/infrastructure/review'
import { findSelfGateRunForShard } from '@/modules/collaboration/infrastructure/clarify/service'
import { isTargetNodeConsumed } from '@/modules/collaboration/infrastructure/clarify/rerunLedger'
import { DrizzleMemoryInjectionReadStore } from '@/modules/memory/infrastructure/memoryInjectionReadStore'
import { loadInjectedSnapshotFromFirstAttempt } from '@/modules/memory/application/injection/injectMemory'
import {
  deriveBudgetUsed,
  deriveMemberCurrentRuns,
  deriveWorkgroupRunHistory,
} from '@/modules/resource-catalog/application/workgroups/workgroupRoomProjection'
import { describeEachProvider } from './helpers/eachProvider'
import {
  taskFixture,
  workflowFixture,
  nodeRunFixture,
  patchNodeRunFixture,
  readNodeRunFixtures,
  nodeRunOutputFixture,
  clarifyRoundFixture,
  type NodeRunFixtureSpec,
} from './helpers/model'
import { patchLegacyRunSelectionFixture } from './helpers/model/runSelectionOracle'

async function seed(db: PersistenceDb, suffix: string) {
  const taskId = `sites-b-${suffix}`
  const workflowId = `${taskId}-workflow`
  const definition = { $schema_version: 2, inputs: [], nodes: [], edges: [] }
  await workflowFixture(db, { id: workflowId, name: workflowId, definition })
  await taskFixture(db, {
    id: taskId,
    workflowId,
    workflowSnapshot: definition,
    repoPath: '/nonexistent/rfc395-sites-b',
    worktreePath: '/nonexistent/rfc395-sites-b',
    baseBranch: 'main',
    branch: `test/${taskId}`,
    status: 'running',
    inputs: {},
    startedAt: 0,
  })
  const id = (name: string) => `${taskId}-${name}`
  let sequence = 0
  const add = async (name: string, nodeId: string, fields: Partial<NodeRunFixtureSpec> = {}) => {
    await nodeRunFixture(db, {
      id: id(name),
      taskId,
      nodeId,
      seq: ++sequence,
      status: 'done',
      ...fields,
    })
    return id(name)
  }
  return { taskId, id, add }
}

describeEachProvider('RFC-395 II-a A3 sites-b legacy decisions', (harness) => {
  test('G3/G4 review sees other containers, but an in-place reset cannot replace a newer row in its own slot', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'review')
    await add('wrapper', 'wrapper', { rerunCause: 'wrapper-init' })
    await add('root', 'review', { status: 'awaiting_review', retryIndex: 9 })
    await add('other-frame', 'review', { containerRunId: id('wrapper'), status: 'done' })
    const facts = await createNodeRunQueries(db).list({ taskId, nodeId: 'review' })
    const picked = await pickFreshestReviewRun(facts)
    expect(picked.reuse?.id).toBe(id('other-frame'))
    expect(picked.latestDone?.id).toBe(id('other-frame'))
    const reader = createRunSelectionReader(db)
    const root = {
      kind: 'node' as const,
      nodeId: 'review',
      frame: { containerRunId: null, iteration: 0 },
    }
    expect((await reader.current(taskId, root))?.id).toBe(id('root'))
    await withTaskExecutionWrite(db, async (tx) => {
      await patchNodeRunFixture(tx, { id: id('root') }, { status: 'pending', reviewIteration: 1 })
      const before = await readNodeRunFixtures(tx, { taskId })
      const reopened = await createNodeRunQueries(tx).read(id('root'))
      expect(await reselectRunInTx(tx, reopened!, 'iterate-review')).toEqual([])
      expect(await readNodeRunFixtures(tx, { taskId })).toEqual(before)
    })
    expect((await reader.current(taskId, root))?.id).toBe(id('root'))
    await add('new-root', 'review', { status: 'awaiting_review' })
    await withTaskExecutionWrite(db, async (tx) => {
      const old = await createNodeRunQueries(tx).read(id('root'))
      expect(await reselectRunInTx(tx, old!, 'review-sibling-cascade')).toEqual([])
    })
    expect((await reader.current(taskId, root))?.id).toBe(id('new-root'))
  })

  test('G3 selection validation participates in the same cancel/adopt transaction', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'selection-tx')
    await add('pending', 'agent', { status: 'pending' })
    const run = (await createRunSelectionReader(db).current(taskId, {
      kind: 'node',
      nodeId: 'agent',
      frame: { containerRunId: null, iteration: 0 },
    }))!
    const invalid = {
      kind: 'clear' as const,
      taskId,
      slot: run.slot,
      expectedRevision: -1,
      generationSeq: 0,
      cause: 'cancel-by-supersede',
    }
    const before = await readNodeRunFixtures(db, { taskId })
    await expect(
      new DrizzleNodeRunLifecyclePersistence(db).transition({
        nodeRunId: run.id,
        event: { kind: 'cancel-by-supersede', reason: 'superseded-by-newer-generation' },
        selection: invalid,
      }),
    ).rejects.toThrow('invalid-selection-revision')
    expect(await readNodeRunFixtures(db, { taskId })).toEqual(before)
    await expect(
      new DrizzleNodeExecutionPersistence(db).patch({
        nodeRunId: run.id,
        values: { identity: { errorMessage: 'adopted' } },
        selection: invalid,
      }),
    ).rejects.toThrow('invalid-selection-revision')
    expect(await readNodeRunFixtures(db, { id: id('pending') })).toEqual(before)
  })

  test('G4 clarify window keeps inclusive trigger, cross-frame retries, child upper bounds and missing-anchor fallback', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'clarify')
    await add('wrapper', 'wrapper', { rerunCause: 'wrapper-init' })
    await add('trigger', 'agent', { rerunCause: 'clarify-answer', status: 'failed' })
    await add('retry', 'agent', {
      rerunCause: 'process-retry',
      containerRunId: id('wrapper'),
      startedAt: 40,
    })
    await add('next-trigger-child', 'agent', {
      rerunCause: 'clarify-answer',
      parentNodeRunId: id('wrapper'),
    })
    await add('later', 'agent', { status: 'running', startedAt: 80 })
    const facts = await createNodeRunQueries(db).list({ taskId })
    const runs = facts.map((run) => ({ ...run, loopIter: 0, hasOutput: run.id === id('retry') }))
    const input: ResolveHandlerInput = {
      effectiveTargetNodeId: 'agent',
      iteration: 0,
      loopIter: 0,
      triggerRunId: id('trigger'),
      runs,
    }
    expect(await resolveHandlerRun(input)).toEqual({
      status: 'done',
      startedAt: 40,
      hasOutput: true,
    })
    for (const triggerRunId of [id('trigger'), id('retry'), id('missing'), null])
      for (const shardKey of [undefined, null, 'other']) {
        const candidate = { ...input, triggerRunId, shardKey }
        expect(await resolveHandlerRun(candidate)).toEqual(legacyHandler(candidate))
      }
    expect(
      await isTargetNodeConsumed('agent', 0, id('trigger'), facts, new Set([id('retry')])),
    ).toBe(true)
    await patchNodeRunFixture(
      db,
      { id: id('retry') },
      { status: 'canceled', supersededByReview: 'rejected' },
    )
    expect(
      await isTargetNodeConsumed(
        'agent',
        0,
        id('trigger'),
        await createNodeRunQueries(db).list({ taskId }),
        new Set([id('retry')]),
      ),
    ).toBe(true)
  })

  test('G4 cross-context facts preserve unrecognized historical cause and merge-state values', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'historical-facts')
    await add('legacy', 'agent', {
      rerunCause: 'pre-port-cause',
      mergeState: 'pre-port-merge-state',
    })
    const facts = await createNodeRunQueries(db).read(id('legacy'))
    expect(facts?.rerunCause).toBe('pre-port-cause')
    expect(facts?.mergeState).toBe('pre-port-merge-state')
    expect(
      (await createRunSelectionReader(db).familyHistory(taskId, { nodeId: 'agent' })).map(
        (run) => run.id,
      ),
    ).toEqual([id('legacy')])
  })

  test('G4 prior output may come from a canceled child in another container', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'output')
    await add('wrapper-a', 'wrapper', { rerunCause: 'wrapper-init' })
    await add('old-output', 'agent', {
      parentNodeRunId: id('wrapper-a'),
      containerRunId: id('wrapper-a'),
      shardKey: 's',
      rerunCause: 'fanout-shard',
      status: 'canceled',
      supersededByReview: 'iterated',
    })
    await nodeRunOutputFixture(db, {
      nodeRunId: id('old-output'),
      portName: 'out',
      content: 'retained',
    })
    await add('wrapper-b', 'wrapper', { rerunCause: 'wrapper-init' })
    await add('current', 'agent', {
      parentNodeRunId: id('wrapper-b'),
      containerRunId: id('wrapper-b'),
      shardKey: 's',
      rerunCause: 'fanout-shard',
      status: 'pending',
    })
    const current = (await createNodeRunQueries(db).read(id('current')))!
    expect(
      (await freshestPriorRunWithOutput(new DrizzleNodeExecutionPersistence(db), current))?.id,
    ).toBe(id('old-output'))
    expect(
      await createRunSelectionReader(db).slotHistory(taskId, {
        kind: 'node',
        nodeId: 'agent',
        frame: { containerRunId: id('wrapper-b'), iteration: 0 },
      }),
    ).toEqual([])
  })

  test('G4 memory generation, distill and scheduler completion retain their different frame-less sets', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'memory')
    const snapshot = [
      {
        id: 'memory',
        version: 1,
        scopeType: 'agent' as const,
        scopeId: 'a',
        title: 'title',
        bodyMd: 'body',
        tags: [],
        sourceKind: 'review',
        approvedAt: null,
      },
    ]
    await add('wrapper', 'wrapper', { rerunCause: 'wrapper-init' })
    await add('old-done', 'agent', { injectedMemories: [] })
    await add('generation', 'agent', {
      containerRunId: id('wrapper'),
      status: 'failed',
      injectedMemories: snapshot,
    })
    await add('retry', 'agent', { status: 'running', rerunCause: 'process-retry' })
    const store = new DrizzleMemoryInjectionReadStore(db)
    expect(
      await loadInjectedSnapshotFromFirstAttempt(store, {
        taskId,
        nodeId: 'agent',
        iteration: 0,
        shardKey: null,
        reviewIteration: 0,
        runId: id('retry'),
      }),
    ).toEqual(snapshot)
    await add('done-child', 'agent', {
      parentNodeRunId: id('wrapper'),
      containerRunId: id('wrapper'),
      rerunCause: 'fanout-shard',
    })
    expect(
      (
        await new DrizzleSchedulerCompletionPersistence(db).listDoneNodeRuns({
          taskId,
          nodeId: 'agent',
          iteration: 0,
        })
      )
        .map((run) => run.id)
        .sort(),
    ).toEqual([id('old-done'), id('done-child')].sort())
    expect(
      (await createNodeRunQueries(db).latestPerNode([taskId])).find((run) => run.nodeId === 'agent')
        ?.id,
    ).toBe(id('done-child'))
    expect(
      (
        await store.listRunRecords({
          taskId,
          nodeId: 'agent',
          iteration: 0,
          shardKey: null,
          reviewIteration: 0,
        })
      ).map((run) => run.id),
    ).not.toContain(id('done-child'))
  })

  test('G5 host slots ignore round/frame, preserve null/empty budget grouping and running-first member display', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'workgroup')
    await add('wrapper', 'wrapper', { rerunCause: 'wrapper-init' })
    await add('killed', '__wg_leader__', {
      status: 'interrupted',
      rerunCause: 'clarify-answer',
      wgRound: null,
    })
    await add('new-empty', '__wg_leader__', {
      shardKey: '',
      rerunCause: 'wg-leader-round',
      wgRound: 7,
      containerRunId: id('wrapper'),
    })
    await add('running-member', '__wg_member__', {
      shardKey: 'assignment',
      status: 'running',
      rerunCause: 'wg-assignment',
      agentOverrideId: 'agent',
    })
    await add('newer-member', '__wg_member__', {
      shardKey: 'assignment',
      status: 'done',
      rerunCause: 'wg-assignment',
      agentOverrideId: 'agent',
    })
    const hostIds = new Set(
      (
        await createRunSelectionReader(db).familyHistory(taskId, {
          syntheticKind: 'workgroup-host',
        })
      ).map((run) => run.id),
    )
    const facts = (await createNodeRunQueries(db).list({ taskId })).filter((run) =>
      hostIds.has(run.id),
    )
    const hosts = await projectWorkgroupRunSelections(facts)
    const killed = hosts.find((run) => run.id === id('killed'))!
    expect(killed.selection.current).toBe(true)
    expect(killed.selection.legacyGroupCurrent).toBe(false)
    expect(deriveBudgetUsed('leader_worker', hosts)).toBe(7)
    const members = [
      { id: 'leader', memberType: 'agent' as const, agentId: 'leader-agent' },
      { id: 'member', memberType: 'agent' as const, agentId: 'agent' },
    ]
    const assignments = [{ id: 'assignment', assigneeMemberId: 'member' }]
    const history = deriveWorkgroupRunHistory(members, 'leader', hosts, assignments, [])
    expect(history.map((run) => run.nodeRunId)).toEqual([
      id('killed'),
      id('new-empty'),
      id('running-member'),
      id('newer-member'),
    ])
    expect(
      deriveMemberCurrentRuns(members, 'leader', hosts, assignments, []).member?.nodeRunId,
    ).toBe(id('running-member'))
    expect(
      (
        await createRunSelectionReader(db).current(taskId, {
          kind: 'workgroup-host',
          nodeId: '__wg_member__',
          shardKey: 'assignment',
        })
      )?.id,
    ).toBe(id('newer-member'))
  })

  test('G6 synthetic prep keeps retry-index ranking; task-wide commit recovery does not become parent-scoped', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'synthetic')
    await add('parent', 'agent')
    await add('prep-high', '__repo_prep__', { retryIndex: 8 })
    await add('prep-late', '__repo_prep__', { retryIndex: 1 })
    await add('commit-old', '__commit_push__', {
      parentNodeRunId: id('parent'),
      rerunCause: 'commit-push',
      status: 'interrupted',
    })
    await add('commit-late', '__commit_push__:next', {
      rerunCause: 'commit-push',
      status: 'failed',
    })
    const reader = createRunSelectionReader(db)
    const prep = {
      kind: 'synthetic' as const,
      owner: { kind: 'task' as const, id: taskId },
      syntheticKind: 'repo-prep' as const,
      discriminator: '__repo_prep__',
    }
    expect((await reader.current(taskId, prep))?.id).toBe(id('prep-high'))
    expect(
      (await reader.slotHistory(taskId, prep, { attemptIndexGreaterThan: 1 })).map((run) => run.id),
    ).toEqual([id('prep-high')])
    const commitHistory = await reader.familyHistory(
      taskId,
      { syntheticKind: 'commit-push' },
      { rerunCause: 'commit-push' },
    )
    expect(commitHistory.at(-1)?.id).toBe(id('commit-late'))
    expect(commitHistory.at(-1)?.status).toBe('failed')
    expect((await reader.familyHistory(taskId, { runIds: [id('commit-old')] }))[0]?.role).toBe(
      'synthetic',
    )
  })

  test('G7 SQL timeline retains NULLS FIRST while review display uses NULL=0; G9 backfill stays in migration code', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'display')
    await add('wrapper', 'wrapper', { startedAt: 5, rerunCause: 'wrapper-init' })
    await add('body', 'body', { startedAt: -1 })
    await add('null-start', 'agent', { startedAt: null })
    await add('legacy-null-seq', 'agent', { startedAt: null })
    await patchLegacyRunSelectionFixture(db, id('legacy-null-seq'), { seq: null })
    const facts = await createNodeRunQueries(db).list({ taskId })
    const payload = await taskNodeRunsProjection(
      {
        db,
        nodeRunPrompts: {
          async read() {
            return null
          },
          async store() {
            throw new Error('unexpected prompt write')
          },
        },
      },
      taskId,
    )
    expect((await createCodeWorkspaceRead(db).listNodeRuns(taskId)).map((run) => run.id)).toEqual([
      id('legacy-null-seq'),
      id('null-start'),
      id('body'),
      id('wrapper'),
    ])
    expect(payload.runs.map((run) => run.id)).toEqual([
      id('body'),
      id('legacy-null-seq'),
      id('null-start'),
      id('wrapper'),
    ])
    expect(
      planFrameBackfill({ parentOf: new Map([['body', 'wrapper']]), rows: facts }).updates,
    ).toEqual([{ id: id('body'), containerRunId: id('wrapper'), scopePath: 'wrapper:0' }])
  })

  test('G12 self gate reuse follows clarify_rounds.createdAt, not NodeRun seq', async () => {
    const { db } = harness
    const { taskId, id, add } = await seed(db, 'self-gate')
    await add('asking', 'agent')
    await add('first-run', 'clarify', { status: 'awaiting_human' })
    await add('later-run', 'clarify', { status: 'awaiting_human' })
    for (const [name, intermediaryNodeRunId, createdAt] of [
      ['early-round', id('later-run'), 10],
      ['late-round', id('first-run'), 20],
    ] as const)
      await clarifyRoundFixture(db, {
        id: id(name),
        taskId,
        kind: 'self',
        askingNodeId: 'agent',
        askingNodeRunId: id('asking'),
        intermediaryNodeId: 'clarify',
        intermediaryNodeRunId,
        questions: [],
        iteration: 0,
        createdAt,
      })
    expect(
      (
        await findSelfGateRunForShard(db, taskId, 'clarify', null, 0, {
          containerRunId: null,
          frameIteration: 0,
        })
      )?.id,
    ).toBe(id('later-run'))
  })
})
