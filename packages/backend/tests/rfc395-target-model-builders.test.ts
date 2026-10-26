import { executeSqliteFixtureSql } from '../../../e2e/fixtures/sqlite-statements'
// Raw target rows and domain constraints are independent of the fixture DTO projections.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createTestDb } from './helpers/testDatabase'
import { decodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import {
  taskFixtureSql,
  nodeRunFixtureSql,
  patchNodeRunFixtureSql,
  workflowFixtureSql,
  patchWorkgroupPauseReasonFixtureSql,
  readWorkgroupPauseReasonFixtureSql,
} from '../../../e2e/fixtures/model'
import { eq } from 'drizzle-orm'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { nodeRunRowPresence } from '@/modules/task-execution/domain/nodeRunRowPresence'
import { contentRefColumns } from '@/platform/content/contentStore'
import { describeEachProvider } from './helpers/eachProvider'
import {
  agentFixture,
  clarifyRoundFixture,
  nodeRunFixture,
  nodeRunOutputFixture,
  patchAgentFixture,
  patchNodeRunFixture,
  patchTaskRepoFixture,
  patchWorkflowFixture,
  readAgentFixtures,
  readClarifyRoundFixtures,
  readNodeRunFixtures,
  readTaskRepoFixtures,
  readTaskFixtures,
  taskFixture,
  workflowFixture,
  type TaskFixtureSpec,
} from './helpers/model'
const task = (id: string): TaskFixtureSpec => ({
  id,
  workflowId: 'wf',
  workflowSnapshot: { nodes: [], edges: [] },
  repoPath: '/repo',
  worktreePath: '/work',
  baseBranch: 'main',
  branch: 'fixture',
  status: 'running',
  inputs: {},
  startedAt: 10,
})

test('row presence preserves zero, false and empty facts without inventing role-based rows', () => {
  expect(nodeRunRowPresence({ role: 'synthetic', recordMode: 'executable' })).toEqual({
    config: false,
    runtimeState: false,
    result: false,
  })
  expect(
    nodeRunRowPresence({
      role: null,
      recordMode: 'history-only',
      config: { runtime: '' },
      runtime: { pid: 0 },
      result: { rolledBack: false },
    }),
  ).toEqual({ config: true, runtimeState: true, result: true })
  expect(
    nodeRunRowPresence({
      role: 'node-attempt',
      recordMode: 'executable',
      config: { runtime: null },
      runtime: { pid: null },
      result: { tokTotal: null },
    }),
  ).toEqual({ config: false, runtimeState: false, result: false })
})

describeEachProvider('RFC-395 target model builder constraints', (h) => {
  test('omitted workspace kind retains the epoch-1 remote fixture default', async () => {
    await taskFixture(h.db, task('default-space'))
    expect((await readTaskFixtures(h.db, { id: 'default-space' }))[0]?.spaceKind).toBe('remote')
  })

  test('parent ownership distinguishes aggregator and shard slots without relabeling top-level attempts', async () => {
    await taskFixture(h.db, task('identity'))
    await nodeRunFixture(h.db, [
      { id: 'container', taskId: 'identity', nodeId: 'wrapper', status: 'done' },
      { id: 'top', taskId: 'identity', nodeId: 'n', status: 'pending', shardKey: '' },
      {
        id: 'aggregator',
        taskId: 'identity',
        nodeId: 'n',
        status: 'done',
        parentNodeRunId: 'container',
        containerRunId: 'container',
      },
      {
        id: 'shared',
        taskId: 'identity',
        nodeId: 'fan',
        status: 'done',
        parentNodeRunId: 'container',
      },
      {
        id: 'shard',
        taskId: 'identity',
        nodeId: 'fan',
        status: 'done',
        parentNodeRunId: 'container',
        rerunCause: 'fanout-shard',
        shardKey: '',
      },
    ])
    const t = tablesOf(h.db)
    const native = await h.db.select().from(t.nodeRuns)
    const slot = (id: string) =>
      decodeCanonicalRunSlot(native.find((row) => row.id === id)!.slotKey!)
    expect(native.find((row) => row.id === 'container')?.role).toBe('container')
    expect(slot('top')).toEqual({
      kind: 'node',
      nodeId: 'n',
      frame: { containerRunId: null, iteration: 0 },
    })
    expect(slot('aggregator')).toEqual({ kind: 'aggregator', nodeId: 'n', iteration: 0 })
    expect(slot('shared')).toEqual({ kind: 'shard', nodeId: 'fan', iteration: 0, shardKey: null })
    expect(slot('shard')).toEqual({ kind: 'shard', nodeId: 'fan', iteration: 0, shardKey: '' })
    expect(
      (await h.db.select().from(t.nodeRunSelections)).map((row) => row.selectedRunId).sort(),
    ).toEqual(['aggregator', 'container', 'shard', 'shared', 'top'])
  })

  test('task split owns definition, launch, workspace, mount and generation atomically', async () => {
    await taskFixture(h.db, task('aggregate'))
    const t = tablesOf(h.db)
    expect(await h.db.select().from(t.tasks)).toMatchObject([
      { id: 'aggregate', workspaceRootRef: '/work' },
    ])
    expect(await h.db.select().from(t.taskDefinitions)).toMatchObject([
      {
        taskId: 'aggregate',
        definitionOrigin: 'authored',
        subjectKind: 'workflow',
        sourceId: 'wf',
        definitionRevision: 1,
      },
    ])
    expect(await h.db.select().from(t.taskLaunchContexts)).toMatchObject([
      { taskId: 'aggregate', executionLineageId: 'aggregate', launchOrigin: 'manual' },
    ])
    expect(await h.db.select().from(t.taskExecutionGenerations)).toMatchObject([
      { taskId: 'aggregate', generationSeq: 0, previousGenerationSeq: null, cause: 'task-created' },
    ])
    expect(await h.db.select().from(t.taskRepositoryMounts)).toMatchObject([
      { taskId: 'aggregate', repoKey: 'aggregate:mount:', ordinal: 0, branchState: 'branch' },
    ])
    expect(Object.keys((await h.db.select().from(t.tasks))[0]!)).not.toContain('workflowSnapshot')
    await expect(
      h.session.transaction(async (tx) => {
        await taskFixture(tx, task('abort'))
        throw new Error('abort aggregate')
      }),
    ).rejects.toThrow('abort aggregate')
    for (const table of [
      t.taskDefinitions,
      t.taskLaunchContexts,
      t.taskWorkspaces,
      t.taskExecutionGenerations,
      t.taskRepositoryMounts,
    ])
      expect(await h.db.select().from(table).where(eq(table.taskId, 'abort'))).toEqual([])
  })
  test('repo key is stable across ordinal changes and one non-root mount is not a root', async () => {
    await taskFixture(h.db, {
      ...task('mounts'),
      repos: [
        {
          repoIndex: 0,
          mountPath: 'svc',
          repoPath: '/repo/svc',
          worktreePath: '/work/svc',
          branch: '',
        },
      ],
    })
    const t = tablesOf(h.db)
    const before = (await h.db.select().from(t.taskRepositoryMounts))[0]!
    await patchTaskRepoFixture(h.db, { taskId: 'mounts', repoIndex: 0 }, { repoIndex: 7 })
    const after = (await h.db.select().from(t.taskRepositoryMounts))[0]!
    expect(after.repoKey).toBe(before.repoKey)
    expect(after.ordinal).toBe(7)
    expect(after.branchState).toBe('none')
    expect((await readTaskRepoFixtures(h.db))[0]).toMatchObject({
      repoIndex: 7,
      mountPath: 'svc',
      worktreePath: '/work/svc',
    })
    await nodeRunFixture(h.db, {
      id: 'run',
      taskId: 'mounts',
      nodeId: 'node',
      status: 'done',
      checkpoints: [{ mountPath: 'svc', preSnapshot: '', submodules: {} }],
    })
    expect(await h.db.select().from(t.nodeRunRepoCheckpoints)).toMatchObject([
      { repoKey: before.repoKey, preSnapshot: '', nodeTree: null, submodules: '{}' },
    ])
    await expect(
      nodeRunFixture(h.db, {
        id: 'wrong',
        taskId: 'mounts',
        nodeId: 'node',
        status: 'done',
        checkpoints: [{ mountPath: '', preSnapshot: '' }],
      }),
    ).rejects.toThrow('node-run-checkpoint-mount-missing')
    expect(await h.db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, 'wrong'))).toEqual([])
  })
  test('companions follow recorded values and input absence differs from recorded-empty', async () => {
    await taskFixture(h.db, task('runs'))
    await nodeRunFixture(h.db, [
      { id: 'absent', taskId: 'runs', nodeId: 'absent', status: 'done' },
      {
        id: 'empty',
        taskId: 'runs',
        nodeId: 'empty',
        status: 'done',
        consumedEdges: [],
        runtime: '',
        pid: 0,
        tokTotal: 0,
        rolledBack: false,
      },
      { id: 'producer', taskId: 'runs', nodeId: 'producer', status: 'done', shardKey: '' },
      {
        id: 'consumer',
        taskId: 'runs',
        nodeId: 'consumer',
        status: 'done',
        consumedEdges: [
          { producerNodeId: 'producer', producerRunId: 'producer', producerShardKey: '' },
        ],
      },
    ])
    const t = tablesOf(h.db)
    expect(
      (await h.db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, 'absent')))[0]?.inputsRecorded,
    ).toBe(false)
    expect(
      (await h.db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, 'empty')))[0]?.inputsRecorded,
    ).toBe(true)
    expect(await h.db.select().from(t.nodeRunConfigs)).toMatchObject([
      { nodeRunId: 'empty', runtime: '' },
    ])
    expect(await h.db.select().from(t.nodeRunRuntimeStates)).toMatchObject([
      { nodeRunId: 'empty', pid: 0 },
    ])
    expect(await h.db.select().from(t.nodeRunResults)).toMatchObject([
      { nodeRunId: 'empty', tokTotal: 0, rolledBack: false },
    ])
    expect(await h.db.select().from(t.nodeRunInputs)).toMatchObject([
      {
        consumerRunId: 'consumer',
        producerRunId: 'producer',
        producerRunRef: 'producer',
        producerShardSlot: 'shard-v1:key:""',
        ordinal: 0,
      },
    ])
    expect((await readNodeRunFixtures(h.db, { id: 'absent' }))[0]?.consumedEdges).toBeUndefined()
    expect((await readNodeRunFixtures(h.db, { id: 'empty' }))[0]?.consumedEdges).toEqual([])
    await patchNodeRunFixture(h.db, { id: 'empty' }, { tokTotal: null })
    expect(
      (await h.db.select().from(t.nodeRunResults).where(eq(t.nodeRunResults.nodeRunId, 'empty')))[0]
        ?.tokTotal,
    ).toBeNull()
  })
  test('unknown history, history-only lineage and a NULL selection tombstone remain distinct facts', async () => {
    await taskFixture(h.db, {
      ...task('history'),
      executionLineageId: null,
      lineageSlotPathJson: null,
    })
    const t = tablesOf(h.db)
    await h.db.insert(t.nodeRuns).values({
      id: 'unknown',
      taskId: 'history',
      nodeId: 'unknown',
      status: 'done',
      seq: -1,
      generationSeq: 0,
      role: null,
      slotKey: null,
      scopePath: null,
      attemptIndex: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
      lineageSlotPathJson: null,
    })
    const [known] = await nodeRunFixture(h.db, {
      id: 'known',
      taskId: 'history',
      nodeId: 'known',
      status: 'done',
      envelopeNonce: null,
      lineageSlotPathJson: null,
    })
    await h.db.insert(t.nodeRunSelections).values({
      taskId: 'history',
      slotKey: (await h.db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, known!.id)))[0]!
        .slotKey!,
      selectedRunId: null,
      generationSeq: 0,
      revision: 9,
      cause: 'fixture-clear',
      selectedAt: 10,
    })
    expect(
      (await h.db.select().from(t.nodeRuns).where(eq(t.nodeRuns.id, 'unknown')))[0],
    ).toMatchObject({
      role: null,
      slotKey: null,
      scopePath: null,
      attemptIndex: null,
      recordMode: 'history-only',
      lineageSlotPathJson: null,
    })
    expect(await h.db.select().from(t.nodeRunSelections)).toMatchObject([
      { selectedRunId: null, revision: 9 },
    ])
    expect(await h.db.select().from(t.nodeRunConfigs)).toEqual([])
    expect(await h.db.select().from(t.nodeRunRuntimeStates)).toEqual([])
    expect(await h.db.select().from(t.nodeRunResults)).toEqual([])
  })
  test('ordered Agent relations retain duplicates and dangling identities and replacement is atomic', async () => {
    const refs = {
      skills: [
        { kind: 'managed', skillId: 'missing' },
        { kind: 'project', name: '本地' },
        { kind: 'managed', skillId: 'missing' },
      ],
      dependsOn: ['gone', 'gone'],
      mcp: ['m', '', 'm'],
      plugins: ['p', 'p'],
    }
    await agentFixture(h.db, { id: 'agent', name: 'agent', ...refs })
    const t = tablesOf(h.db)
    expect(
      await h.db.select().from(t.agentSkillRefs).orderBy(t.agentSkillRefs.ordinal),
    ).toMatchObject([
      { ordinal: 0, occurrence: 0, skillId: 'missing' },
      { ordinal: 1, occurrence: 0, projectName: '本地' },
      { ordinal: 2, occurrence: 1, skillId: 'missing' },
    ])
    expect(await h.db.select().from(t.agentDependencies)).toHaveLength(2)
    expect(await h.db.select().from(t.agentMcpRefs)).toHaveLength(3)
    expect(await h.db.select().from(t.agentPluginRefs)).toHaveLength(2)
    const before = await readAgentFixtures(h.db)
    await expect(
      h.session.transaction(async (tx) => {
        await patchAgentFixture(
          tx,
          { id: 'agent' },
          { skills: [], dependsOn: [], mcp: [], plugins: [] },
        )
        throw new Error('abort refs')
      }),
    ).rejects.toThrow('abort refs')
    expect(await readAgentFixtures(h.db)).toEqual(before)
    await patchAgentFixture(h.db, { id: 'agent' }, { mcp: [] })
    expect(await h.db.select().from(t.agentMcpRefs)).toEqual([])
    expect(await h.db.select().from(t.agentSkillRefs)).toHaveLength(3)
  })
  test('workflow dependency index follows the current revision and retains canonical bytes', async () => {
    const definition =
      ' { "nodes": [{"id":"a","kind":"agent-single","agentId":"missing","agentName":"name"}], "edges": [] } '
    await workflowFixture(h.db, { id: 'wf', name: 'wf', definition, version: 3 })
    const t = tablesOf(h.db)
    expect(await h.db.select().from(t.workflowDependencyIndex)).toMatchObject([
      { workflowId: 'wf', revision: 3 },
    ])
    await patchWorkflowFixture(
      h.db,
      { id: 'wf' },
      { definition: '{"nodes":[],"edges":[]}', version: 4 },
    )
    expect(await h.db.select().from(t.workflowDependencyIndex)).toEqual([])
  })
  test('clarify answers preserve occurrences independently from drafts and attribution-only history', async () => {
    await taskFixture(h.db, task('clarify'))
    await nodeRunFixture(h.db, { id: 'ask', taskId: 'clarify', nodeId: 'ask', status: 'done' })
    const base = {
      taskId: 'clarify',
      kind: 'self' as const,
      askingNodeId: 'ask',
      askingNodeRunId: 'ask',
      intermediaryNodeId: 'ask',
      intermediaryNodeRunId: 'ask',
      questions: [],
    }
    await clarifyRoundFixture(h.db, [
      {
        ...base,
        id: 'answered',
        answers: [
          { questionId: 'q', answer: 'first' },
          { questionId: 'q', answer: 'last' },
        ],
        draftAnswers: {},
        answerAttributions: { orphan: { source: 'history' } },
      },
      { ...base, id: 'absent' },
      { ...base, id: 'empty', answers: [] },
    ])
    const t = tablesOf(h.db)
    expect(
      await h.db.select().from(t.clarifyAnswers).orderBy(t.clarifyAnswers.ordinal),
    ).toMatchObject([
      { occurrence: 0, ordinal: 0 },
      { occurrence: 1, ordinal: 1 },
    ])
    expect(await h.db.select().from(t.clarifyAnswerDrafts)).toEqual([])
    expect(await h.db.select().from(t.clarifyAnswerAttributions)).toMatchObject([
      { roundId: 'answered', questionId: 'orphan' },
    ])
    expect((await readClarifyRoundFixtures(h.db, { id: 'absent' }))[0]?.answers).toBeNull()
    expect((await readClarifyRoundFixtures(h.db, { id: 'empty' }))[0]?.answers).toBe('[]')
  })
  test('output ContentRef stores the exact UTF-8 bytes and no legacy content column', async () => {
    await taskFixture(h.db, task('content'))
    await nodeRunFixture(h.db, {
      id: 'content-run',
      taskId: 'content',
      nodeId: 'node',
      status: 'done',
    })
    const text = '精确\u0000\r\n🙂'
    await nodeRunOutputFixture(h.db, { nodeRunId: 'content-run', portName: 'out', content: text })
    const t = tablesOf(h.db)
    const row = (await h.db.select().from(t.nodeRunOutputs))[0]!
    expect(Object.hasOwn(row, 'content')).toBe(false)
    const ref = contentRefColumns.decode(row.contentRefJson, row.contentInlineBytes)
    expect(ref?.kind).toBe('inline')
    expect(Buffer.from(row.contentInlineBytes!)).toEqual(Buffer.from(text, 'utf8'))
  })
})

test('Node-loaded SQLite transport preserves aggregate patches for every originally selected run', async () => {
  const fixture = await createTestDb({ provider: 'sqlite' })
  const raw: unknown = Reflect.get(fixture.db, '$client')
  if (!(raw instanceof Database)) throw new Error('expected SQLite fixture')
  try {
    executeSqliteFixtureSql(
      raw,
      workflowFixtureSql({ id: 'wf', name: 'sql-wf', definition: { nodes: [], edges: [] } }) +
        taskFixtureSql(task('sql')),
    )
    executeSqliteFixtureSql(
      raw,
      nodeRunFixtureSql([
        { id: 'sql-producer', taskId: 'sql', nodeId: 'producer', status: 'done', shardKey: '' },
        { id: 'sql-a', taskId: 'sql', nodeId: 'a', status: 'done' },
        { id: 'sql-b', taskId: 'sql', nodeId: 'b', status: 'done' },
      ]),
    )
    executeSqliteFixtureSql(
      raw,
      patchNodeRunFixtureSql(
        { id: { $in: ['sql-a', 'sql-b'] }, status: 'done' },
        {
          status: 'running',
          promptText: '',
          tokTotal: 0,
          checkpoints: [{ mountPath: '', preSnapshot: '', submodules: {} }],
          consumedEdges: [
            { producerNodeId: 'producer', producerRunId: 'sql-producer', producerShardKey: '' },
          ],
        },
      ),
    )
    expect(
      raw
        .query(
          "SELECT id,status,inputs_recorded FROM node_runs WHERE id IN ('sql-a','sql-b') ORDER BY id",
        )
        .all(),
    ).toEqual([
      { id: 'sql-a', status: 'running', inputs_recorded: 1 },
      { id: 'sql-b', status: 'running', inputs_recorded: 1 },
    ])
    expect(
      raw
        .query(
          'SELECT node_run_id,length(prompt_inline_bytes) AS bytes FROM node_run_configs ORDER BY node_run_id',
        )
        .all(),
    ).toEqual([
      { node_run_id: 'sql-a', bytes: 0 },
      { node_run_id: 'sql-b', bytes: 0 },
    ])
    expect(
      raw.query('SELECT node_run_id,tok_total FROM node_run_results ORDER BY node_run_id').all(),
    ).toEqual([
      { node_run_id: 'sql-a', tok_total: 0 },
      { node_run_id: 'sql-b', tok_total: 0 },
    ])
    expect(
      raw
        .query(
          'SELECT consumer_run_id,producer_run_ref,producer_shard_slot,ordinal FROM node_run_inputs ORDER BY consumer_run_id',
        )
        .all(),
    ).toEqual([
      {
        consumer_run_id: 'sql-a',
        producer_run_ref: 'sql-producer',
        producer_shard_slot: 'shard-v1:key:""',
        ordinal: 0,
      },
      {
        consumer_run_id: 'sql-b',
        producer_run_ref: 'sql-producer',
        producer_shard_slot: 'shard-v1:key:""',
        ordinal: 0,
      },
    ])
    expect(
      raw
        .query(
          'SELECT node_run_id,repo_key,pre_snapshot,submodules FROM node_run_repo_checkpoints ORDER BY node_run_id',
        )
        .all(),
    ).toEqual([
      { node_run_id: 'sql-a', repo_key: 'sql:mount:', pre_snapshot: '', submodules: '{}' },
      { node_run_id: 'sql-b', repo_key: 'sql:mount:', pre_snapshot: '', submodules: '{}' },
    ])
    executeSqliteFixtureSql(
      raw,
      patchNodeRunFixtureSql(
        { taskId: 'sql', status: 'running' },
        { consumedEdges: [], checkpoints: [], promptText: null },
      ),
    )
    expect(raw.query('SELECT * FROM node_run_inputs').all()).toEqual([])
    expect(raw.query('SELECT * FROM node_run_repo_checkpoints').all()).toEqual([])
    expect(
      raw.query('SELECT prompt_ref_json,prompt_inline_bytes FROM node_run_configs').all(),
    ).toEqual([
      { prompt_ref_json: null, prompt_inline_bytes: null },
      { prompt_ref_json: null, prompt_inline_bytes: null },
    ])
    expect(() =>
      raw.transaction(() =>
        executeSqliteFixtureSql(
          raw,
          nodeRunFixtureSql({
            id: 'bad-mount',
            taskId: 'sql',
            nodeId: 'bad',
            status: 'done',
            checkpoints: [{ mountPath: 'missing', preSnapshot: '' }],
          }),
        ),
      )(),
    ).toThrow()
    expect(raw.query("SELECT id FROM node_runs WHERE id='bad-mount'").all()).toEqual([])
  } finally {
    await fixture.close()
  }
})

test('e2e workgroup pause fixture owns nullable and quoted state updates', async () => {
  const fixture = await createTestDb({ provider: 'sqlite' })
  const raw: unknown = Reflect.get(fixture.db, '$client')
  if (!(raw instanceof Database)) throw new Error('expected SQLite fixture')
  try {
    executeSqliteFixtureSql(
      raw,
      taskFixtureSql({ ...task('pause-fixture'), workgroupId: 'wg', workgroupConfigJson: {} }),
    )
    for (const reason of ["reader's pause", '', null]) {
      executeSqliteFixtureSql(raw, patchWorkgroupPauseReasonFixtureSql('pause-fixture', reason))
      expect(raw.query(readWorkgroupPauseReasonFixtureSql('pause-fixture')).all()).toEqual([
        { pause_reason: reason },
      ])
    }
  } finally {
    await fixture.close()
  }
})
