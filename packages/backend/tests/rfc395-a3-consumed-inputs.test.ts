// RFC-395 II-a A3 consumed inputs：双 provider 锁定 source-node 粒度、旧 JSON 字节与 caller-owned transaction 回滚；A1 使用同一生产 codec。
import { expect, test } from 'bun:test'
import {
  createConsumedInputsParticipantInTx,
  prepareConsumedInputs,
} from '@/modules/task-execution/public/participants'
import {
  createRunSelectionReader,
  encodeConsumedEdges,
} from '@/modules/task-execution/public/queries'
import { withTaskExecutionWrite } from '@/modules/task-execution/infrastructure/ownedTaskExecution'
import { describeEachProvider } from './helpers/eachProvider'
import { nodeRunFixture, readNodeRunFixtures, taskFixture, workflowFixture } from './helpers/model'
import { readRunSelectionOracleFixtures } from './helpers/model/runSelectionOracle'

describeEachProvider('RFC-395 II-a A3 consumed input bytes', (harness) => {
  test('production participant, oracle decoder and A1 encode the same ordered Unicode record', async () => {
    const db = harness.db
    await workflowFixture(db, {
      id: 'wf',
      name: 'wf',
      definition: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
    })
    await taskFixture(db, {
      id: 'task',
      workflowId: 'wf',
      workflowSnapshot: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
      repoPath: '/rfc395',
      worktreePath: '/rfc395',
      baseBranch: 'main',
      branch: 'test',
      status: 'running',
      inputs: {},
      startedAt: 0,
    })
    const record = { '10': 'ten', '2': 'two', 源: '运行\n"', alpha: 'a' }
    const edges = Object.entries(record).map(([producerNodeId, producerRunId]) => ({
      producerNodeId,
      producerRunId,
    }))
    await nodeRunFixture(db, {
      id: 'fixture',
      taskId: 'task',
      status: 'done',
      nodeId: 'fixture',
      consumedEdges: edges,
    })
    await nodeRunFixture(db, {
      id: 'production',
      taskId: 'task',
      status: 'done',
      nodeId: 'production',
    })
    await withTaskExecutionWrite(db, (tx) =>
      createConsumedInputsParticipantInTx().record(tx, 'production', { edges }),
    )
    const rows = await readRunSelectionOracleFixtures(db, 'task')
    expect(rows.find((row) => row.id === 'fixture')?.consumedUpstreamRunsJson).toBe(
      JSON.stringify(record),
    )
    expect(rows.find((row) => row.id === 'production')?.consumedUpstreamRunsJson).toBe(
      JSON.stringify(record),
    )
    expect(await createRunSelectionReader(db).consumed('production')).toEqual(edges)
    expect(prepareConsumedInputs({ record }).consumedUpstreamRunsJson).toBe(JSON.stringify(record))
    expect(encodeConsumedEdges(edges)).toBe(JSON.stringify(record))
  })

  test('legacy bytes remain verbatim; malformed/null decode as empty; caller rollback keeps prior bytes', async () => {
    const db = harness.db
    await workflowFixture(db, {
      id: 'wf',
      name: 'wf',
      definition: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
    })
    await taskFixture(db, {
      id: 'task',
      workflowId: 'wf',
      workflowSnapshot: { $schema_version: 6, inputs: [], nodes: [], edges: [] },
      repoPath: '/rfc395',
      worktreePath: '/rfc395',
      baseBranch: 'main',
      branch: 'test',
      status: 'running',
      inputs: {},
      startedAt: 0,
    })
    await nodeRunFixture(db, { id: 'run', taskId: 'task', status: 'done', nodeId: 'node' })
    const participant = createConsumedInputsParticipantInTx()
    const reader = createRunSelectionReader(db)
    const raw = ' { "source" : "original", "ignored": 9 } '
    await withTaskExecutionWrite(db, (tx) => participant.record(tx, 'run', { legacyJson: raw }))
    expect(await reader.consumed('run')).toEqual([
      { producerNodeId: 'source', producerRunId: 'original' },
    ])
    await expect(
      withTaskExecutionWrite(db, async (tx) => {
        await participant.record(tx, 'run', { record: { source: 'replacement' } })
        throw new Error('caller-rollback')
      }),
    ).rejects.toThrow('caller-rollback')
    expect((await readRunSelectionOracleFixtures(db, 'task'))[0]?.consumedUpstreamRunsJson).toBe(
      raw,
    )
    for (const legacyJson of [null, '', '[1]', '{broken', '{"source":1}']) {
      await withTaskExecutionWrite(db, (tx) => participant.record(tx, 'run', { legacyJson }))
      expect(await reader.consumed('run')).toEqual([])
    }
    await withTaskExecutionWrite(db, (tx) => participant.record(tx, 'run', { edges: [] }))
    expect((await readNodeRunFixtures(db, { id: 'run' }))[0]?.consumedEdges).toEqual([])
    expect((await readRunSelectionOracleFixtures(db, 'task'))[0]?.consumedUpstreamRunsJson).toBe(
      '{}',
    )
  })
})

test('epoch-1 cannot encode multiple shard producers under the same source node', () => {
  expect(() =>
    encodeConsumedEdges([
      { producerNodeId: 'inner', producerRunId: 'shard-a' },
      { producerNodeId: 'inner', producerRunId: 'shard-b' },
    ]),
  ).toThrow('Epoch-1 consumed inputs cannot represent two runs for the same producer node')
})
