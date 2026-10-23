// RFC-395 II-a A1: lock target fixture inputs and today's provider behavior before II-b replaces storage.
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import inventory from './fixtures/rfc395-column-destinations.json'
import { describeEachProvider } from './helpers/eachProvider'
import {
  agentFixture,
  clarifyRoundFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchNodeRunFixture,
  readNodeRunFixtures,
  readTaskFixtures,
  taskFixture,
  taskRepoFixture,
  workflowFixture,
  type NodeRunFixtureSpec,
  type TaskFixtureSpec,
  type TaskRepoFixtureSpec,
} from './helpers/model'

const specs = {
  tasks: 'task',
  task_repos: 'taskRepo',
  node_runs: 'nodeRun',
  node_run_outputs: 'nodeRunOutput',
  agents: 'agent',
  workflows: 'workflow',
  clarify_rounds: 'clarifyRound',
}
test('inventory covers every bootstrap contract column once and each settable destination has a public spec field', () => {
  const columns = persistenceSchema.tables
    .filter((t) => t.id in specs)
    .flatMap((table) =>
      Object.entries(table.columns).map(([property, column]) => ({
        table: table.id,
        property,
        physical: column.name,
      })),
    )
  const actual = inventory.columns.map(({ table, property, physical }) => ({
    table,
    property,
    physical,
  }))
  const key = (entry: { table: string; physical: string }) => entry.table + '.' + entry.physical
  expect(actual.sort((a, b) => key(a).localeCompare(key(b)))).toEqual(
    columns.sort((a, b) => key(a).localeCompare(key(b))),
  )
  expect(new Set(actual.map(key)).size).toBe(actual.length)
  for (const [table, module] of Object.entries(specs)) {
    const file = resolve(import.meta.dir, 'helpers/model/' + module + '.spec.ts')
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    )
    const definition = source.statements.find(ts.isInterfaceDeclaration)!
    const accepted = definition.members
      .filter(
        (member): member is ts.PropertySignature =>
          ts.isPropertySignature(member) && member.type?.kind !== ts.SyntaxKind.NeverKeyword,
      )
      .map((member) => member.name.getText(source))
    for (const entry of inventory.columns.filter((entry) => entry.table === table)) {
      expect(accepted, key(entry)).toContain(entry.spec)
      expect(['immutable', 'cas-mutable', 'mutable', 'derived']).toContain(entry.class)
      expect(
        entry.target === 'derived' ||
          entry.target === 'deleted-shape' ||
          /^[a-z_]+\.[a-z_]+$/.test(entry.target),
        key(entry),
      ).toBe(true)
    }
  }
})

// These are compiler controls, not executable inserts; removed shapes must fail even through variables.
function rejectedSpecs(
  task: TaskFixtureSpec,
  repo: TaskRepoFixtureSpec,
  run: NodeRunFixtureSpec,
): void {
  // @ts-expect-error repoCount is derived from repositories
  const count: TaskFixtureSpec = { ...task, repoCount: 3 }
  // @ts-expect-error one canonical mount identity
  const directory: TaskRepoFixtureSpec = { ...repo, worktreeDirName: 'svc' }
  // @ts-expect-error fixtures allocate omitted seq; NULL is a legacy-storage test only
  const nullSeq: NodeRunFixtureSpec = { ...run, seq: null }
  // @ts-expect-error checkpoint dual encoding is not a fixture input
  const checkpoint: NodeRunFixtureSpec = { ...run, preSnapshot: '' }
  // @ts-expect-error consumed provenance is structured
  const consumed: NodeRunFixtureSpec = { ...run, consumedUpstreamRunsJson: '{}' }
  void [count, directory, nullSeq, checkpoint, consumed]
}
void rejectedSpecs

describeEachProvider('RFC-395 II-a A1 model fixtures', (h) => {
  const task = (id: string): TaskFixtureSpec => ({
    id,
    workflowId: 'fixture-workflow',
    workflowSnapshot: {},
    repoPath: '/fixture/repo',
    worktreePath: '/fixture/worktree',
    baseBranch: 'main',
    branch: 'fixture',
    status: 'running',
    inputs: {},
    startedAt: 1,
  })
  test('task defaults, child launch inheritance, explicit mirrors and later repos remain coherent', async () => {
    await workflowFixture(h.db, { id: 'fixture-workflow', name: 'Fixture', definition: {} })
    await taskFixture(h.db, [
      { ...task('root-fixture-task'), launchOrigin: 'event', workflowVersion: 7 },
      { ...task('child-fixture-task'), parentTaskId: 'root-fixture-task', launchOrigin: 'api' },
    ])
    const [root] = await readTaskFixtures(h.db, { id: 'root-fixture-task' })
    const [child] = await readTaskFixtures(h.db, { id: 'child-fixture-task' })
    expect(root!.name).toBe('task-xture-task')
    expect(JSON.parse(root!.lineageSlotPathJson!)).toEqual([
      { stableNodeKey: 'task-root', frozenOccurrenceKey: root!.id, workflowRevision: 7 },
    ])
    expect(child!.executionLineageId).toBe(root!.id)
    expect(child!.launchOrigin).toBe('event')
    expect(child!.repoCount).toBe(1)
    await taskRepoFixture(
      h.db,
      [0, 1].map((repoIndex) => ({
        taskId: root!.id,
        repoIndex,
        repoPath: '/repo/' + repoIndex,
        worktreePath: '/work/' + repoIndex,
        branch: '',
        mountPath: 'svc/' + repoIndex,
      })),
    )
    const { tasks, taskRepos } = tablesOf(h.db)
    expect((await first(h.db.select().from(tasks).where(eq(tasks.id, root!.id))))!.repoCount).toBe(
      2,
    )
    expect((await h.db.select().from(taskRepos)).map((r) => r.worktreeDirName)).toEqual([
      'svc/0',
      'svc/1',
    ])
    expect((await readTaskFixtures(h.db, { id: root!.id }))[0]!.repoPath).toBe('/fixture/repo')
  })
  test('placeholder and materialized root inputs create no implicit epoch-1 repository rows', async () => {
    await taskFixture(h.db, [{ ...task('placeholder'), worktreePath: '' }, task('materialized')])
    const { taskRepos } = tablesOf(h.db)
    expect(await h.db.select().from(taskRepos)).toEqual([])
    const rows = await readTaskFixtures(h.db)
    expect(rows.every((row) => row.repoCount === 1)).toBe(true)
  })
  test('allocation follows call order, preserves negative history and rolls back with the caller', async () => {
    await taskFixture(h.db, task('sequence-task'))
    const rows = await h.session.transaction(async (tx) =>
      nodeRunFixture(tx, [
        { id: 'z-old', taskId: 'sequence-task', nodeId: 'n', status: 'done' },
        { id: 'a-new', taskId: 'sequence-task', nodeId: 'n', status: 'done' },
        { id: 'history', taskId: 'sequence-task', nodeId: 'n', status: 'done', seq: -8 },
      ]),
    )
    expect(rows[0]!.seq!).toBeLessThan(rows[1]!.seq!)
    expect(rows[2]!.seq).toBe(-8)
    await expect(
      h.session.transaction(async (tx) => {
        await nodeRunFixture(tx, {
          id: 'rollback',
          taskId: 'sequence-task',
          nodeId: 'n',
          status: 'pending',
        })
        throw new Error('fixture rollback')
      }),
    ).rejects.toThrow('fixture rollback')
    const { nodeRunSeqAllocations } = tablesOf(h.db)
    expect(
      await h.db
        .select()
        .from(nodeRunSeqAllocations)
        .where(eq(nodeRunSeqAllocations.nodeRunId, 'rollback')),
    ).toEqual([])
    expect(await readNodeRunFixtures(h.db, { id: 'rollback' })).toEqual([])
  })
  test('checkpoints preserve absent, clean-tree and value states for root and one non-root mount', async () => {
    await taskFixture(h.db, task('root-checkpoint'))
    await taskFixture(h.db, {
      ...task('group-checkpoint'),
      repos: [
        {
          repoIndex: 0,
          repoPath: '/repo',
          worktreePath: '/group/svc',
          mountPath: 'svc',
          branch: '',
        },
      ],
    })
    await nodeRunFixture(h.db, [
      {
        id: 'root-run',
        taskId: 'root-checkpoint',
        nodeId: 'n',
        status: 'done',
        checkpoints: [{ mountPath: '', preSnapshot: '', nodeTree: 'tree' }],
      },
      {
        id: 'group-run',
        taskId: 'group-checkpoint',
        nodeId: 'n',
        status: 'done',
        checkpoints: [{ mountPath: 'svc', isolationBase: '', nodeTree: 'group-tree' }],
      },
    ])
    const { nodeRuns } = tablesOf(h.db)
    const root = await first(h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'root-run')))
    const group = await first(h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'group-run')))
    expect(root!.preSnapshot).toBe('')
    expect(root!.isoBaseSnapshot).toBeNull()
    expect(root!.isoNodeTreeReposJson).toBeNull()
    expect(group!.isoNodeTree).toBeNull()
    expect(JSON.parse(group!.isoNodeTreeReposJson!)).toEqual({ svc: 'group-tree' })
    expect((await readNodeRunFixtures(h.db, { id: 'group-run' }))[0]!.checkpoints).toEqual([
      { mountPath: 'svc', isolationBase: '', nodeTree: 'group-tree' },
    ])
    await patchNodeRunFixture(
      h.db,
      { id: 'group-run' },
      { checkpoints: [{ mountPath: 'svc', preSnapshot: '' }] },
    )
    expect((await readNodeRunFixtures(h.db, { id: 'group-run' }))[0]!.checkpoints).toEqual([
      { mountPath: 'svc', preSnapshot: '', isolationBase: '', nodeTree: 'group-tree' },
    ])
    await patchNodeRunFixture(
      h.db,
      { id: 'group-run' },
      { checkpoints: [{ mountPath: 'svc', isolationBase: undefined }] },
    )
    expect((await readNodeRunFixtures(h.db, { id: 'group-run' }))[0]!.checkpoints).toEqual([
      { mountPath: 'svc', preSnapshot: '', nodeTree: 'group-tree' },
    ])
    await patchNodeRunFixture(h.db, { id: 'group-run' }, { checkpoints: [] })
    expect((await readNodeRunFixtures(h.db, { id: 'group-run' }))[0]!.checkpoints).toEqual([])
  })
  test('multiple mounts preserve partial and clean checkpoints, including empty submodules', async () => {
    await taskFixture(h.db, {
      ...task('multi'),
      repos: ['a', 'b'].map((mountPath, repoIndex) => ({
        repoIndex,
        mountPath,
        repoPath: '/repo/' + mountPath,
        worktreePath: '/work/' + mountPath,
        branch: '',
      })),
    })
    await nodeRunFixture(h.db, {
      id: 'multi-run',
      taskId: 'multi',
      nodeId: 'n',
      status: 'done',
      checkpoints: [
        { mountPath: 'a', preSnapshot: '', submodules: '' },
        { mountPath: 'b', nodeTree: 'tree-b', submodules: { lib: 'sha' } },
      ],
    })
    const { nodeRuns } = tablesOf(h.db)
    const stored = (await first(h.db.select().from(nodeRuns).where(eq(nodeRuns.id, 'multi-run'))))!
    expect(stored.preSnapshot).toBeNull()
    expect(JSON.parse(stored.preSnapshotReposJson!)).toEqual({ a: '' })
    expect(JSON.parse(stored.isoNodeTreeReposJson!)).toEqual({ b: 'tree-b' })
    expect((await readNodeRunFixtures(h.db, { id: 'multi-run' }))[0]!.checkpoints).toEqual([
      { mountPath: 'a', preSnapshot: '', submodules: '' },
      { mountPath: 'b', nodeTree: 'tree-b', submodules: { lib: 'sha' } },
    ])
  })
  test('JSON text stays exact, public names encode correctly, and consumed edges retain producer identity', async () => {
    await taskFixture(h.db, task('json-task'))
    await agentFixture(h.db, { id: 'agent', name: 'agent', skills: ' [ ] ' })
    await nodeRunFixture(h.db, [
      { id: 'producer', taskId: 'json-task', nodeId: 'source', shardKey: 's', status: 'done' },
      {
        id: 'consumer',
        taskId: 'json-task',
        nodeId: 'target',
        status: 'done',
        consumedEdges: [
          { producerNodeId: 'source', producerRunId: 'producer', producerShardKey: 's' },
        ],
        injectedMemories: [],
      },
    ])
    await clarifyRoundFixture(h.db, {
      id: 'round',
      taskId: 'json-task',
      kind: 'self',
      askingNodeId: 'source',
      askingNodeRunId: 'producer',
      intermediaryNodeId: 'target',
      intermediaryNodeRunId: 'consumer',
      questions: [],
      answers: [],
      draftAnswers: {},
    })
    await nodeRunOutputFixture(h.db, [
      { nodeRunId: 'producer', portName: 'out', content: 'exact bytes' },
    ])
    const { agents, clarifyRounds, nodeRunOutputs } = tablesOf(h.db)
    expect((await first(h.db.select().from(agents).where(eq(agents.id, 'agent'))))!.skills).toBe(
      ' [ ] ',
    )
    expect(
      (await first(h.db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'round'))))!
        .answersJson,
    ).toBe('[]')
    expect((await first(h.db.select().from(nodeRunOutputs)))!.content).toBe('exact bytes')
    const consumer = (await readNodeRunFixtures(h.db, { id: 'consumer' }))[0]!
    expect(consumer.consumedEdges).toEqual([
      { producerNodeId: 'source', producerRunId: 'producer', producerShardKey: 's' },
    ])
    expect(consumer.injectedMemories).toBe('[]')
  })
  test('projection reads compose filters and order before pagination on each provider', async () => {
    await taskFixture(h.db, task('read-options'))
    const seeded = await nodeRunFixture(h.db, [
      { id: 'read-old', taskId: 'read-options', nodeId: 'step', status: 'done', retryIndex: 0 },
      { id: 'read-middle', taskId: 'read-options', nodeId: 'step', status: 'done', retryIndex: 1 },
      { id: 'read-new', taskId: 'read-options', nodeId: 'step', status: 'done', retryIndex: 2 },
      {
        id: 'read-other',
        taskId: 'read-options',
        nodeId: 'other',
        status: 'running',
        retryIndex: 3,
      },
    ])
    const rows = await readNodeRunFixtures(
      h.db,
      {
        $and: [{ taskId: 'read-options' }, { nodeId: 'step' }, { retryIndex: { $gte: 0 } }],
      },
      { orderBy: [{ field: 'seq', direction: 'desc' }], offset: 1, limit: 1 },
    )
    expect(rows.map((row) => row.id)).toEqual(['read-middle'])
    expect(rows[0]!.seq).toBe(seeded[1]!.seq)
    expect(
      (
        await readNodeRunFixtures(
          h.db,
          {
            taskId: 'read-options',
            $or: [{ status: 'running' }, { retryIndex: { $in: [0, 2] } }],
            parentNodeRunId: null,
          },
          { orderBy: [{ field: 'seq' }] },
        )
      ).map((row) => row.id),
    ).toEqual(['read-old', 'read-new', 'read-other'])
  })
})
