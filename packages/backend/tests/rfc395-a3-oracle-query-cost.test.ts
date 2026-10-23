// RFC-395 A3 fix round: cost is statements/projections/rows, compared with frozen HEAD queries.
import { expect, test } from 'bun:test'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRunFixture, taskFixture, workflowFixture } from './helpers/model'
import {
  FrozenMemoryInjectionQueries,
  FrozenMemoryDistillQueries,
} from './helpers/model/frozenSelection/memoryQueries'
import { DrizzleMemoryInjectionReadStore } from '@/modules/memory/infrastructure/memoryInjectionReadStore'
import { DrizzleMemoryDistillWorkStore } from '@/modules/memory/infrastructure/memoryDistillWorkStore'
import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { DrizzleNodeExecutionPersistence } from '@/modules/task-execution/infrastructure/nodeExecutionPersistence'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import { DrizzleSchedulerCompletionPersistence } from '@/modules/task-execution/infrastructure/schedulerCompletionPersistence'
import { DrizzleNodeActivationSnapshotReader } from '@/modules/task-execution/infrastructure/nodeActivationSnapshotReader'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { reselectRunInTx } from '@/modules/task-execution/infrastructure/runSelection/selectionWrite'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/runSelection/oracle/snapshot'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/oracle/reader'
import type { NodeRunLifecyclePersistence } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import { buildNodeRunMintRecord } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import { deriveNodeRunRole } from '@/modules/task-execution/domain/nodeRunRole'
import {
  oracleRunRef,
  type OracleRunRow,
} from '@/modules/task-execution/infrastructure/runSelection/oracle/rows'
import type { StatementRecording } from './helpers/statementRecorder'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'

const selectShape = (recording: StatementRecording) =>
  recording.selects().map((entry) => ({
    projection: entry.sql.slice(0, entry.sql.toLowerCase().indexOf(' from ')).replace(/\s+/g, ' '),
    values: entry.values,
    rows: entry.rows,
  }))

describeEachProvider('RFC-395 A3 oracle query costs', (harness) => {
  async function seed() {
    await workflowFixture(harness.db, { id: 'query-wf', name: 'query-wf', definition: '{}' })
    for (const taskId of ['query-a', 'query-b']) {
      await taskFixture(harness.db, {
        id: taskId,
        workflowId: 'query-wf',
        workflowSnapshot: '{}',
        repoPath: '/query',
        worktreePath: '/query',
        baseBranch: 'main',
        branch: taskId,
        status: 'running',
        inputs: '{}',
        startedAt: 1,
      })
      await nodeRunFixture(harness.db, [
        {
          id: taskId + '-wrapper',
          taskId,
          nodeId: 'wrapper',
          status: 'pending',
          rerunCause: 'wrapper-init',
        },
        { id: taskId + '-old', taskId, nodeId: 'n', status: 'done', injectedMemories: [] },
        {
          id: taskId + '-new',
          taskId,
          nodeId: 'n',
          status: 'done',
          injectedMemories: [],
          mergeState: 'pending-merge',
        },
        {
          id: taskId + '-shard',
          taskId,
          nodeId: 'n',
          status: 'done',
          parentNodeRunId: taskId + '-wrapper',
          containerRunId: taskId + '-wrapper',
          shardKey: 'x',
        },
      ])
    }
  }

  test('memory injection and distillation preserve HEAD statement counts, narrow projections and batching', async () => {
    await seed()
    const oldInjection = new FrozenMemoryInjectionQueries(harness.db)
    const injection = new DrizzleMemoryInjectionReadStore(harness.db)
    const oldDistill = new FrozenMemoryDistillQueries(harness.db)
    const distill = new DrizzleMemoryDistillWorkStore(
      harness.db,
      createClarifyAnswerQueries(harness.db),
    )
    const input = {
      taskId: 'query-a',
      nodeId: 'n',
      iteration: 0,
      shardKey: null,
      reviewIteration: 0,
    }
    const ids = ['query-a-old', 'query-b-new']
    const pairs = [
      [() => oldInjection.listRunRecords(input), () => injection.listRunRecords(input)],
      [() => oldDistill.listAgentRunSources(ids), () => distill.listAgentRunSources(ids)],
      [() => oldDistill.listNodeRuns(ids), () => distill.listNodeRuns(ids)],
      [
        () => oldDistill.listTaskNodeStatuses(['query-a', 'query-b']),
        () => distill.listTaskNodeStatuses(['query-a', 'query-b']),
      ],
    ] as const
    for (const [oldRead, read] of pairs) {
      const before = harness.recordStatements()
      let expected: unknown
      try {
        expected = await oldRead()
      } finally {
        before.stop()
      }
      const after = harness.recordStatements()
      try {
        const actual: unknown = await read()
        expect(actual).toEqual(expected)
      } finally {
        after.stop()
      }
      expect(before.selects()).toHaveLength(1)
      expect(selectShape(after)).toEqual(selectShape(before))
      expect(after.selects()[0]!.sql).not.toContain('task_repos')
    }
  })

  test('park facts stay PK reads and re-opening a review adds no selection query', async () => {
    await seed()
    const run = (await createNodeRunQueries(harness.db).read('query-a-new'))!
    expect(Object.keys(run)).not.toContain('preSnapshot')
    expect(Object.keys(run)).not.toContain('checkpoints')
    await harness.session.transaction(async (tx) => {
      const queries = createNodeRunQueries(tx)
      const recording = harness.recordStatements()
      try {
        expect(await queries.readFields('query-a-new', ['iteration'])).toEqual({ iteration: 0 })
        expect(recording.selects()).toHaveLength(1)
        expect(recording.selects()[0]!.values).toContain('query-a-new')
        expect(recording.selects()[0]!.sql).toMatch(/limit/i)
        expect(recording.selects()[0]!.sql).not.toContain('task_repos')
        const count = recording.statements.length
        expect(await reselectRunInTx(tx, run, 'review-reset')).toEqual([])
        expect(recording.statements).toHaveLength(count)
      } finally {
        recording.stop()
      }
    })
  })

  test('node activation and wrapper consumed reads stay node-scoped; resumable fetch returns at most one run', async () => {
    await seed()
    const reader = new DrizzleNodeActivationSnapshotReader(harness.db)
    const activation = harness.recordStatements()
    try {
      const rows = await reader.findRuns('query-a', 'n')
      const history = await reader.selectionFromRows('query-a', rows).slotHistory(
        'query-a',
        {
          kind: 'node',
          nodeId: 'n',
          frame: { containerRunId: null, iteration: 0 },
        },
        { statusIn: ['done', 'skipped'] },
      )
      expect(history.at(-1)?.id).toBe('query-a-new')
      expect(activation.selects()).toHaveLength(1)
      expect(activation.selects()[0]!.values).toEqual(['query-a', 'n'])
      expect(activation.selects()[0]!.sql).not.toContain('prompt_text')
    } finally {
      activation.stop()
    }
    const wrapper = new DrizzleWrapperRunPersistence(harness.db)
    const consumed = harness.recordStatements()
    try {
      expect(
        await wrapper.resolveConsumed({
          taskId: 'query-a',
          sources: [{ nodeId: 'n', frame: { containerRunId: null, iteration: 0 } }],
        }),
      ).toEqual({ n: 'query-a-new' })
      expect(consumed.selects()).toHaveLength(1)
      expect(consumed.selects()[0]!.values).toEqual(['query-a', 'n'])
    } finally {
      consumed.stop()
    }
    const resumed = harness.recordStatements()
    try {
      expect(
        (
          await wrapper.findResumable({
            taskId: 'query-a',
            nodeId: 'wrapper',
            containerRunId: null,
            iteration: 0,
          })
        )?.id,
      ).toBe('query-a-wrapper')
      const runs = resumed.selects().filter((entry) => entry.sql.includes('node_runs'))
      expect(runs).toHaveLength(1)
      expect(runs[0]!.rows).toBe(1)
      expect(runs[0]!.sql).toMatch(/limit/i)
    } finally {
      resumed.stop()
    }
  })

  test('AC-8 cancel-by-supersede preserves the current slot until the next top-level mint', async () => {
    await seed()
    await nodeRunFixture(harness.db, [
      { id: 'ac8-pending', taskId: 'query-a', nodeId: 'ac8', status: 'pending' },
      {
        id: 'ac8-child',
        taskId: 'query-a',
        nodeId: 'ac8',
        status: 'done',
        parentNodeRunId: 'query-a-wrapper',
      },
    ])
    const lifecycle = new DrizzleNodeRunLifecyclePersistence(harness.db)
    const nodes = new DrizzleNodeExecutionPersistence(harness.db)
    const rows = await nodes.list({ taskId: 'query-a', nodeId: 'ac8' })
    const transitions: Parameters<NodeRunLifecyclePersistence['transition']>[0][] = []
    const result = await resolveSchedulerRunRow({
      taskId: 'query-a',
      nodeId: 'ac8',
      iteration: 0,
      containerRunId: null,
      rows,
      selection: createRunSelectionOracleSnapshot(rows, {
        scope: { kind: 'node', taskId: 'query-a', nodeId: 'ac8' },
      }),
      projections: nodes,
      lifecycle: {
        mint: async () => 'not-yet-persisted',
        transition: async (input) => {
          transitions.push(input)
          return lifecycle.transition(input)
        },
        set: (input) => lifecycle.set(input),
        loadEnvelopeNonce: (id) => lifecycle.loadEnvelopeNonce(id),
      },
      consumedUpstreamJson: '{}',
      inheritReviewIteration: false,
      clearAgentOverride: false,
      trackRetryIndex: false,
      broadcastPending: null,
    })
    expect(result.nodeRunId).toBe('not-yet-persisted')
    expect(transitions).toHaveLength(1)
    expect(transitions[0]?.selection).toBeUndefined()
    expect(
      await createRunSelectionReader(harness.db).current('query-a', {
        kind: 'node',
        nodeId: 'ac8',
        frame: { containerRunId: null, iteration: 0 },
      }),
    ).toMatchObject({ id: 'ac8-pending', status: 'canceled' })
  })

  test('S16 uses one node-run statement with EXISTS; S21 keeps the narrow unordered query', async () => {
    await seed()
    const nodes = new DrizzleNodeExecutionPersistence(harness.db)
    const listing = harness.recordStatements()
    try {
      const rows = await nodes.list({ taskId: 'query-a', nodeId: 'n', excludeSuperseded: true })
      expect(rows.map((row) => row.id)).not.toContain('query-a-old')
      const statements = listing.selects().filter((entry) => entry.sql.includes('node_runs'))
      expect(statements).toHaveLength(1)
      expect(statements[0]!.sql).toMatch(/exists/i)
      expect(statements[0]!.sql).toContain('nr_container_child')
      expect(statements[0]!.sql).toContain('task_id')
    } finally {
      listing.stop()
    }
    const transition = harness.recordStatements()
    try {
      await new DrizzleMergeStateLifecyclePersistence(harness.db).transition({
        nodeRunId: 'query-a-new',
        event: { kind: 'mark-merged' },
      })
      const reads = transition.selects().filter((entry) => entry.sql.includes('node_runs'))
      expect(reads).toHaveLength(2) // HEAD: merge state PK read, then the supersession PK/EXISTS read.
      expect(reads[1]!.sql).toMatch(/exists/i)
      expect(reads[1]!.sql).toMatch(/limit/i)
      expect(reads[1]!.values).toContain('query-a-new')
    } finally {
      transition.stop()
    }
    const done = harness.recordStatements()
    try {
      const rows = await new DrizzleSchedulerCompletionPersistence(harness.db).listDoneNodeRuns({
        taskId: 'query-a',
        nodeId: 'n',
        iteration: 0,
      })
      expect(rows).toHaveLength(3)
      expect(done.selects()).toHaveLength(1)
      expect(done.selects()[0]!.sql).not.toMatch(/order by/i)
      expect(done.selects()[0]!.sql).not.toContain('prompt_text')
    } finally {
      done.stop()
    }
  })
})

test('mint resolves parent and container overrides before enforcing both born-running rules', () => {
  const base = {
    ...deriveNodeRunRole({ nodeId: 'n', rerunCause: 'initial' }),
    taskId: 't',
    nodeId: 'n',
    status: 'running' as const,
    cause: 'initial' as const,
    inheritFrom: {
      reviewIteration: 0,
      shardKey: null,
      parentNodeRunId: 'parent',
      containerRunId: 'container',
      checkpointInheritance: [],
    },
  }
  expect(buildNodeRunMintRecord(base)).toMatchObject({
    parentNodeRunId: 'parent',
    containerRunId: 'container',
  })
  expect(() => buildNodeRunMintRecord({ ...base, containerRunId: null })).toThrow('containerRunId')
  expect(buildNodeRunMintRecord({ ...base, containerRunId: 'explicit' }).containerRunId).toBe(
    'explicit',
  )
  expect(() =>
    buildNodeRunMintRecord({ ...base, overrides: { identity: { parentNodeRunId: null } } }),
  ).toThrow('parentNodeRunId')
  const synthetic = {
    ...base,
    ...deriveNodeRunRole({ nodeId: '__commit_push__:n', rerunCause: 'commit-push' }),
    nodeId: '__commit_push__:n',
    cause: 'commit-push' as const,
  }
  expect(() => buildNodeRunMintRecord({ ...synthetic, inheritFrom: null })).toThrow(
    'parentNodeRunId',
  )
  expect(buildNodeRunMintRecord({ ...synthetic, containerRunId: null }).parentNodeRunId).toBe(
    'parent',
  )
})

test('labelling and supersession index a 6000-row snapshot once instead of scanning it per reference', () => {
  let containerReads = 0
  const rows: OracleRunRow[] = Array.from({ length: 6000 }, (_, index) => ({
    id: `run-${index}`,
    taskId: 't',
    nodeId: `node-${index % 20}`,
    seq: index,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: null,
    shardKey: null,
    shardValueHash: null,
    reviewIteration: 0,
    wgRound: null,
    rerunCause: 'initial',
    wrapperProgressJson: null,
    consumedUpstreamRunsJson: null,
    childTaskId: null,
    startedAt: null,
    mergeState: null,
    supersededByReview: null,
    get containerRunId() {
      containerReads += 1
      return null
    },
  }))
  const refs = rows.map((row) => oracleRunRef(row, rows))
  expect(refs.filter((row) => !row.structurallySuperseded)).toHaveLength(20)
  expect(refs.every((row) => row.role === 'node-attempt' && row.slot.kind === 'node')).toBe(true)
  expect(containerReads).toBeLessThan(6000 * 20)
})
