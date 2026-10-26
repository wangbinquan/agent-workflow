import { epoch2RuntimeTestPorts } from './helpers/epoch2RuntimePorts'
import { o2Ports } from './helpers/o2Closure'
// RFC-395 II-a A3 sites-a：双 provider 锁定帧、消费新鲜度、跨代 fanout 与 call 收养的旧决策，避免简单 MAX(seq) 替换。
import { expect, test } from 'bun:test'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createTaskExecutionPersistence } from '@/modules/task-execution/composition/taskExecutionPersistence'
import { createWrapperMechanicsPorts } from '@/modules/task-execution/composition/wrapperMechanics'
import {
  readPortRowAtFrame,
  type SchedulerState,
} from '@/modules/task-execution/composition/nodeMechanics'
import { deriveFrontier } from './helpers/frontierSelection'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import { selectResumeRollbackTargets } from '@/services/task'
import { createLogger } from '@/util/log'
import { describeEachProvider } from './helpers/eachProvider'
import {
  nodeRunFixture,
  nodeRunOutputFixture,
  readNodeRunFixtures,
  taskFixture,
  workflowFixture,
  type NodeRunFixtureSpec,
} from './helpers/model'

const definition: WorkflowDefinition = { $schema_version: 6, inputs: [], nodes: [], edges: [] }
async function seed(db: PersistenceDb) {
  await workflowFixture(db, { id: 'wf', name: 'wf', definition })
  await taskFixture(db, {
    id: 'task',
    workflowId: 'wf',
    workflowSnapshot: definition,
    repoPath: '/rfc395',
    worktreePath: '/rfc395',
    baseBranch: 'main',
    branch: 'test',
    inputs: {},
    startedAt: 0,
    status: 'running',
  })
}
async function run(
  db: PersistenceDb,
  id: string,
  nodeId: string,
  spec: Partial<NodeRunFixtureSpec> = {},
) {
  await nodeRunFixture(db, { id, taskId: 'task', nodeId, status: 'done', ...spec })
}
function wrapperPorts(db: PersistenceDb, def = definition) {
  const persistence = createTaskExecutionPersistence(db, {
    historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
    recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
  })
  const state = {
    taskId: 'task',
    task: {},
    definition: def,
    opts: { persistence, defaultNodeRetries: 0 },
    taskExecutionResources: {
      injection: async () => ({
        kind: 'failed',
        summary: 'stop before agent',
        message: 'fixture-stop',
      }),
    },
  } as unknown as SchedulerState
  return createWrapperMechanicsPorts(state, createLogger('sites-a-fixture'))
}
const shardInput = {
  wrapperId: 'wrapper',
  wrapperRunId: 'w-new',
  innerNode: { id: 'inner', kind: 'agent-single' } as WorkflowNode,
  innerAgent: { id: 'agent' } as Agent,
  iteration: 0,
  shard: { shardKey: 'A', value: 'value' },
  shardSourcePortName: 'items',
  boundaryEdges: [],
  broadcastInputs: {},
  reuseDisabled: false,
}

describeEachProvider('RFC-395 II-a A3 sites-a decisions', (harness) => {
  test('G1 frame reads choose settled top-level history, then preserve skipped ports', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'wrapper', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'old-done', 'source', { retryIndex: 9 })
    await nodeRunOutputFixture(db, { nodeRunId: 'old-done', portName: 'answer', content: 'kept' })
    await run(db, 'new-pending', 'source', { status: 'pending' })
    await run(db, 'other-frame', 'source', { containerRunId: 'wrapper' })
    await run(db, 'child', 'source', { parentNodeRunId: 'wrapper', containerRunId: 'wrapper' })
    const persistence = createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    })
    const read = () =>
      readPortRowAtFrame(persistence.nodeExecution, 'task', 'source', 'answer', {
        containerRunId: null,
        iteration: 0,
      })
    expect(await read()).toMatchObject({ runId: 'old-done', content: 'kept', active: true })
    await run(db, 'skipped', 'source', { status: 'skipped' })
    expect(await read()).toMatchObject({ runId: 'skipped', content: '', active: false })
  })

  test('G1 frontier preserves in-frame insertion order after excluding earlier rows in other frames', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'wrapper', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'other-frame-b', 'b', { status: 'exhausted', containerRunId: 'wrapper' })
    await run(db, 'current-a', 'a', { status: 'exhausted' })
    await run(db, 'current-b', 'b', { status: 'exhausted' })
    const nodes = [
      { id: 'a', kind: 'agent-single' },
      { id: 'b', kind: 'agent-single' },
    ] as WorkflowNode[]
    const rows = await createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    }).nodeExecution.list({ taskId: 'task' })
    const frontier = await deriveFrontier(
      rows,
      { ...definition, nodes },
      nodes,
      new Set(['a', 'b']),
      { containerRunId: null, iteration: 0 },
      new Map(),
      new Set(),
      new Set(),
      new Set(),
    )
    expect(frontier.exhausted).toEqual(['a', 'b'])
  })

  test('G1 container latest terminal row prevents falling back to an older resumable row', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'waiting', 'wrapper', {
      status: 'awaiting_human',
      rerunCause: 'wrapper-init',
      retryIndex: 20,
    })
    const persistence = createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    })
    const input = { taskId: 'task', nodeId: 'wrapper', containerRunId: null, iteration: 0 }
    expect((await persistence.wrapperRuns.findResumable(input))?.id).toBe('waiting')
    await run(db, 'terminal', 'wrapper', { status: 'failed', rerunCause: 'wrapper-init' })
    expect(await persistence.wrapperRuns.findResumable(input)).toBeNull()
  })

  test('G1 resume preserves cross-frame latest and ignores child rows and retry-index priority', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'w-old', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'w-new', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'retry-old', 'node', {
      status: 'failed',
      retryIndex: 30,
      containerRunId: 'w-old',
    })
    await run(db, 'settled-new', 'node', { containerRunId: 'w-new' })
    await run(db, 'failed-child', 'node', {
      status: 'failed',
      parentNodeRunId: 'w-new',
      containerRunId: 'w-new',
    })
    const rows = await createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    }).nodeExecution.list({ taskId: 'task' })
    expect((await selectResumeRollbackTargets(rows)).map((row) => row.id)).toEqual([])
  })

  test('G2 shard replay crosses wrapper generations and ignores other shard and top-level placeholders', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'w-old', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'w-new', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'shard-old', 'inner', {
      parentNodeRunId: 'w-old',
      containerRunId: 'w-old',
      shardKey: 'A',
      shardValueHash: null,
    })
    await nodeRunOutputFixture(db, { nodeRunId: 'shard-old', portName: 'out', content: 'reused' })
    await run(db, 'other-shard', 'inner', {
      parentNodeRunId: 'w-new',
      containerRunId: 'w-new',
      shardKey: 'B',
      status: 'failed',
    })
    await run(db, 'placeholder', 'inner', { status: 'pending' })
    expect(await wrapperPorts(db).fanoutAttempts.dispatchShard(shardInput)).toMatchObject({
      kind: 'ok',
      outputs: { out: 'reused' },
    })
    expect(
      (await readNodeRunFixtures(db, { taskId: 'task' })).filter((row) => row.nodeId === 'inner'),
    ).toHaveLength(3)
  })

  test('G2 latest same-generation failed shard reruns in place instead of replaying older done output', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'w-old', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'w-new', 'wrapper', { rerunCause: 'wrapper-init' })
    await run(db, 'old-done', 'inner', {
      parentNodeRunId: 'w-old',
      containerRunId: 'w-old',
      shardKey: 'A',
    })
    await run(db, 'rerun', 'inner', {
      parentNodeRunId: 'w-new',
      containerRunId: 'w-new',
      shardKey: 'A',
      status: 'failed',
    })
    expect(await wrapperPorts(db).fanoutAttempts.dispatchShard(shardInput)).toMatchObject({
      kind: 'failed',
      message: 'fixture-stop',
    })
    const rows = await readNodeRunFixtures(db, { taskId: 'task', nodeId: 'inner' })
    expect(rows).toHaveLength(2)
    expect(rows.find((row) => row.id === 'rerun')?.errorMessage).toBe('fixture-stop')
  })

  for (const advanceShard of [false, true])
    test(`G2 aggregator replay uses participating shard order; advance=${advanceShard}`, async () => {
      const db = harness.db
      await seed(db)
      await run(db, 'w-old', 'wrapper', { rerunCause: 'wrapper-init' })
      await run(db, 'w-new', 'wrapper', { rerunCause: 'wrapper-init' })
      await run(db, 'shard', 'inner', {
        parentNodeRunId: 'w-old',
        containerRunId: 'w-old',
        shardKey: 'A',
      })
      await run(db, 'agg', 'aggregator', {
        parentNodeRunId: 'w-old',
        containerRunId: 'w-old',
        rerunCause: 'fanout-aggregator',
      })
      await nodeRunOutputFixture(db, {
        nodeRunId: 'agg',
        portName: 'summary',
        content: 'prior-summary',
      })
      if (advanceShard)
        await run(db, 'new-shard', 'inner', {
          parentNodeRunId: 'w-new',
          containerRunId: 'w-new',
          shardKey: 'A',
        })
      await run(db, 'unrelated-latest', 'unrelated')
      const def: WorkflowDefinition = {
        ...definition,
        edges: [
          {
            id: 'inner-agg',
            source: { nodeId: 'inner', portName: 'out' },
            target: { nodeId: 'aggregator', portName: 'parts' },
          },
        ],
      }
      const result = await wrapperPorts(db, def).fanoutAttempts.dispatchAggregator({
        wrapperId: 'wrapper',
        wrapperRunId: 'w-new',
        node: { id: 'aggregator', kind: 'agent-single' } as WorkflowNode,
        agent: { id: 'agent' } as Agent,
        iteration: 0,
        shards: [{ shardKey: 'A', value: 'value' }],
        definition: def,
        scope: {
          perShard: new Set(['inner']),
          shared: new Set(),
          aggregatorId: 'aggregator',
          shardSourceName: 'items',
        },
        reuseDisabled: false,
      })
      expect(result.kind).toBe(advanceShard ? 'failed' : 'ok')
      if (!advanceShard)
        expect(result).toMatchObject({ aggRunId: 'agg', outputs: { summary: 'prior-summary' } })
      expect((await readNodeRunFixtures(db, { id: 'agg' }))[0]?.consumedEdges).toBeUndefined()
    })

  test('G10 pending upstream does not stale a skip; newer settled evidence releases it once', async () => {
    const db = harness.db
    await seed(db)
    await run(db, 'source-done', 'source')
    await run(db, 'skip', 'target', {
      status: 'skipped',
      consumedEdges: [{ producerNodeId: 'source', producerRunId: 'source-done' }],
    })
    await run(db, 'source-pending', 'source', { status: 'pending' })
    const nodes = [
      { id: 'source', kind: 'agent-single' },
      { id: 'target', kind: 'agent-single' },
    ] as WorkflowNode[]
    const def = { ...definition, nodes }
    const persistence = createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    })
    const frontier = async (released = new Set<string>()) =>
      deriveFrontier(
        await persistence.nodeExecution.list({ taskId: 'task' }),
        def,
        nodes,
        new Set(['source', 'target']),
        { containerRunId: null, iteration: 0 },
        new Map([['target', ['source']]]),
        new Set(),
        new Set(['target']),
        new Set(),
        new Set(),
        released,
      )
    expect((await frontier()).completed.has('target')).toBe(true)
    await run(db, 'source-new', 'source')
    const stale = await frontier()
    expect(stale.ready).toContain('target')
    expect(stale.pendingAnchors.get('target')).toBe('source-new')
    expect((await frontier(new Set(['source-new']))).ready).not.toContain('target')
  })

  test('G11 call adoption uses the selected frame row despite newer startedAt, higher retry, or a child row', async () => {
    const db = harness.db
    await seed(db)
    await taskFixture(db, {
      id: 'child',
      workflowId: 'wf',
      workflowSnapshot: definition,
      repoPath: '/rfc395',
      worktreePath: '/rfc395',
      baseBranch: 'main',
      branch: 'child',
      inputs: {},
      startedAt: 0,
      status: 'pending',
    })
    await run(db, 'old-call', 'call', { status: 'interrupted', startedAt: 9999, retryIndex: 20 })
    await run(db, 'selected-call', 'call', {
      status: 'interrupted',
      startedAt: 1,
      childTaskId: 'child',
    })
    await run(db, 'child-row', 'call', {
      status: 'pending',
      parentNodeRunId: 'selected-call',
      containerRunId: 'selected-call',
    })
    const persistence = createTaskExecutionPersistence(db, {
      historyRestrictions: epoch2RuntimeTestPorts(db).historyRestrictions,
      recoveryHumanGates: o2Ports(db).collaborationReads.recovery,
    })
    const rows = await persistence.nodeExecution.list({
      taskId: 'task',
      nodeId: 'call',
      iteration: 0,
    })
    const result = await resolveSchedulerRunRow({
      taskId: 'task',
      nodeId: 'call',
      iteration: 0,
      containerRunId: null,
      rows,
      selection: persistence.selection,
      lifecycle: persistence.nodeRuns,
      projections: persistence.nodeExecution,
      consumedUpstreamJson: '{}',
      inheritReviewIteration: true,
      clearAgentOverride: true,
      trackRetryIndex: true,
      broadcastPending: null,
      preResolve: async (selected) =>
        selected?.childTaskId === 'child' ? { nodeRunId: selected.id } : null,
    })
    expect(result).toMatchObject({
      nodeRunId: 'selected-call',
      adopted: true,
      latestExisting: { childTaskId: 'child' },
    })
    expect(await readNodeRunFixtures(db, { taskId: 'task', nodeId: 'call' })).toHaveLength(3)
  })
})
