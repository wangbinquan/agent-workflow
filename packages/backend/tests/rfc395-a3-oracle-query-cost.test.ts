import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { withTargetMintIdentity } from './helpers/rfc395Mint'
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
import type { NodeActivationSnapshotReader } from '@/modules/task-execution/application/ports/nodeActivationSnapshotReader'
import { DrizzleNodeActivationSnapshotReader } from '@/modules/task-execution/infrastructure/nodeActivationSnapshotReader'
import { DrizzleMergeStateLifecyclePersistence } from '@/modules/task-execution/infrastructure/mergeStateLifecyclePersistence'
import { reselectRunInTx } from '@/modules/task-execution/infrastructure/runSelection/selectionWrite'
import { resolveSchedulerRunRow } from '@/modules/task-execution/application/resolveSchedulerRunRow'
import { DrizzleNodeRunLifecyclePersistence } from '@/modules/task-execution/infrastructure/nodeRunLifecyclePersistence'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import type { NodeRunLifecyclePersistence } from '@/modules/task-execution/application/ports/nodeRunLifecyclePersistence'
import { buildNodeRunMintRecord } from '@/modules/task-execution/application/buildNodeRunMintRecord'
import {
  oracleRunRef,
  type OracleRunRow,
} from '@/modules/task-execution/infrastructure/migration/oracle/rows'
import type { StatementRecording } from './helpers/statementRecorder'
import { createClarifyAnswerQueries } from '@/modules/collaboration/composition'

// Scalar target projections contain nested SELECTs; stop only at the outer FROM.
function outerProjection(statement: string): string {
  let depth = 0
  let quoted: string | null = null
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index]!
    if (quoted !== null) {
      if (char === quoted) {
        if (statement[index + 1] === quoted) index++
        else quoted = null
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') quoted = char
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (depth === 0 && /^\sfrom\s/i.test(statement.slice(index)))
      return statement.slice(0, index).replace(/\s+/g, ' ')
  }
  throw new Error('recorded SELECT has no outer FROM')
}
// Compare logical scalar columns, allowing only the required epoch-1 evidence envelope.
// Qualification and column order change with target companion joins, not their payload cost.
function scalarColumns(statement: string): { columns: string[]; history: boolean } {
  const projection = outerProjection(statement)
    .replace(/"[a-z_]+"\./g, '')
    .replace(/^select /i, '')
  const columns: string[] = []
  let depth = 0,
    start = 0
  for (let i = 0; i < projection.length; i++) {
    if (projection[i] === '(') depth++
    if (projection[i] === ')') depth--
    if (projection[i] === ',' && depth === 0) {
      columns.push(projection.slice(start, i).trim())
      start = i + 1
    }
  }
  columns.push(projection.slice(start).trim())
  const evidence = [
    'id',
    'task_id',
    'record_mode',
    'role',
    'slot_key',
    'attempt_index',
    'scope_path',
    'content_ref_json',
    'content_inline_bytes',
  ].map((column) => `"${column}"`)
  const history = evidence.every((column, index) => columns[index] === column)
  if (history) columns.splice(0, evidence.length)
  return { columns: columns.sort(), history }
}
const selectShape = (recording: StatementRecording) =>
  recording.selects().map((entry) => {
    const { columns, history } = scalarColumns(entry.sql)
    const values = [...entry.values]
    if (history) {
      expect(values.shift()).toBe('node-run')
    }
    if (values.at(-1) === 'executable') values.pop()
    return { projection: columns, values, rows: entry.rows }
  })

test('cost comparison keeps extra full-document columns visible', () => {
  expect(scalarColumns('select "id", "runtime_config_json" from "tasks"').columns).toEqual([
    '"id"',
    '"runtime_config_json"',
  ])
  expect(scalarColumns('select "id", "prompt_inline_bytes" from "node_runs"').columns).not.toEqual(
    scalarColumns('select "id" from "node_runs"').columns,
  )
})

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
      expect(after.selects()[0]!.sql).not.toMatch(/select\s+(?:[\w"]+\.)?\*/i)
      if (!before.selects()[0]!.sql.includes('prompt_inline_bytes'))
        expect(after.selects()[0]!.sql).not.toContain('prompt_inline_bytes')
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

  test('node activation and wrapper consumed reads stay node-scoped; resumable selection and snapshot each return at most one run', async () => {
    await seed()
    const reader: NodeActivationSnapshotReader = new DrizzleNodeActivationSnapshotReader(harness.db)
    const activation = harness.recordStatements()
    try {
      const history = await reader.selection.slotHistory(
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
      expect(activation.selects()[0]!.values).toContain('query-a')
      expect(activation.selects()[0]!.values).toContain(
        encodeCanonicalRunSlot({
          kind: 'node',
          nodeId: 'n',
          frame: { containerRunId: null, iteration: 0 },
        }),
      )
      expect(activation.selects()[0]!.sql).not.toMatch(/prompt_ref_json|prompt_inline_bytes/)
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
      expect(consumed.selects()[0]!.values).toEqual([
        'query-a',
        encodeCanonicalRunSlot({
          kind: 'node',
          nodeId: 'n',
          frame: { containerRunId: null, iteration: 0 },
        }),
      ])
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
      expect(runs).toHaveLength(2) // Selected slot identity, then the selected aggregate snapshot.
      expect(runs.map((entry) => entry.rows)).toEqual([1, 1])
      expect(runs[0]!.sql).toContain('node_run_selections')
      expect(runs[1]!.values).toContain('query-a-wrapper')
      expect(runs[1]!.sql).toMatch(/limit/i)
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
      selection: createRunSelectionReader(harness.db),
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

  test('S16 uses bounded identity/selection/snapshot batches; the write protocol uses PK reads; S21 stays narrow', async () => {
    await seed()
    const nodes = new DrizzleNodeExecutionPersistence(harness.db)
    const listing = harness.recordStatements()
    try {
      const rows = await nodes.list({ taskId: 'query-a', nodeId: 'n', excludeSuperseded: true })
      expect(rows.map((row) => row.id)).not.toContain('query-a-old')
      const statements = listing.selects().filter((entry) => entry.sql.includes('node_runs'))
      expect(statements).toHaveLength(3) // Node IDs, selection predicate, batched companion snapshot.
      expect(statements[0]!.values).toContain('n')
      expect(statements[1]!.values).toContain('n')
      expect(statements[1]!.sql).toMatch(/exists/i)
      expect(statements[1]!.sql).toContain('nr_superseded_parent')
      expect(statements[2]!.rows).toBe(rows.length)
      expect(statements.every((entry) => entry.rows <= 3)).toBe(true)
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
      const facts = reads.filter((entry) => !/for update/i.test(entry.sql))
      expect(facts).toHaveLength(6) // Locate/fence/root, selection identity/predicate, protocol locate/run lock read.
      expect(facts.every((entry) => entry.rows === 1 && entry.values.includes('query-a-new'))).toBe(
        true,
      )
      expect(facts.filter((entry) => /exists/i.test(entry.sql))).toHaveLength(1)
      expect(facts.every((entry) => !/prompt_ref_json|prompt_inline_bytes/.test(entry.sql))).toBe(
        true,
      )
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
      expect(done.selects()[0]!.sql).not.toMatch(/prompt_ref_json|prompt_inline_bytes/)
    } finally {
      done.stop()
    }
  })
})

test('mint resolves historical parent independently and enforces the explicit node frame', () => {
  const base = {
    role: 'node-attempt' as const,
    syntheticKind: null,
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
  expect(buildNodeRunMintRecord(withTargetMintIdentity(base))).toMatchObject({
    parentNodeRunId: 'parent',
    containerRunId: 'container',
  })
  expect(() =>
    buildNodeRunMintRecord(withTargetMintIdentity({ ...base, containerRunId: null })),
  ).toThrow('containerRunId')
  expect(
    buildNodeRunMintRecord(withTargetMintIdentity({ ...base, containerRunId: 'explicit' }))
      .containerRunId,
  ).toBe('explicit')
  expect(
    buildNodeRunMintRecord(
      withTargetMintIdentity({ ...base, overrides: { identity: { parentNodeRunId: null } } }),
    ).parentNodeRunId,
  ).toBeNull()
  const synthetic = {
    ...base,
    role: 'synthetic' as const,
    syntheticKind: 'commit-push' as const,
    nodeId: '__commit_push__:n',
    cause: 'commit-push' as const,
  }
  expect(
    buildNodeRunMintRecord(withTargetMintIdentity({ ...synthetic, inheritFrom: null })).role,
  ).toBe('synthetic')
  expect(
    buildNodeRunMintRecord(withTargetMintIdentity({ ...synthetic, containerRunId: null }))
      .parentNodeRunId,
  ).toBe('parent')
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
