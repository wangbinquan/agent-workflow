// RFC-395 N-a: revisions and caller-owned atomicity on each real provider.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { readOnlyProbes } from '@/modules/task-execution/infrastructure/runSelection/table/probes'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/runSelection/table/selectionWrite'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { writeNodeRunTablesInTx } from '@/modules/task-execution/infrastructure/nodeRunWriteProtocol'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { validateSelectionChange } from '@/modules/task-execution/domain/runSelection/changes'
import type {
  SelectionChange,
  RunSlot,
} from '@/modules/task-execution/application/ports/runSelection'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'

const slot: RunSlot = {
  kind: 'node',
  nodeId: 'worker',
  frame: { containerRunId: null, iteration: 0 },
}
const change = (id: string, expectedRevision: number, generationSeq = 0): SelectionChange => ({
  kind: 'select',
  taskId: 't',
  slot,
  run: { id, taskId: 't', slot, containerRunId: null, parentNodeRunId: null, shardKey: null },
  expectedRevision,
  generationSeq,
  cause: 'test-selection',
})

describeEachProvider('RFC-395 selection table CAS', (h) => {
  function transaction<T>(body: (tx: PersistenceTx) => Promise<T>): Promise<T> {
    return h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      return body(tx)
    })
  }
  async function insertHistoryRun() {
    await insertOne(h.db, tablesOf(h.db).nodeRuns, {
      id: 'history',
      taskId: 't',
      nodeId: 'worker',
      seq: 3,
      role: 'node-attempt',
      slotKey: encodeCanonicalRunSlot(slot),
      generationSeq: 0,
      attemptIndex: 0,
      scopePath: '',
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
      status: 'done',
    })
  }
  async function seed() {
    const definition = {
      $schema_version: 2,
      nodes: [{ id: 'worker', kind: 'agent-single', agentName: 'worker' }],
      edges: [],
      inputs: [],
    }
    await workflowFixture(h.db, { id: 'w', name: 'w', definition })
    await taskFixture(h.db, {
      id: 't',
      workflowId: 'w',
      workflowSnapshot: definition,
      repoPath: '',
      worktreePath: '',
      baseBranch: 'main',
      branch: 'task',
      status: 'running',
      inputs: {},
      startedAt: 1,
    })
    const { nodeRuns, taskExecutionGenerations } = tablesOf(h.db)
    await insertOne(h.db, taskExecutionGenerations, {
      taskId: 't',
      generationSeq: 1,
      cause: 'retry',
      previousGenerationSeq: 0,
      operationRef: 'retry-1',
      createdAt: 2,
    })
    for (const [seq, id] of ['r1', 'r2'].entries())
      await insertOne(h.db, nodeRuns, {
        id,
        taskId: 't',
        nodeId: 'worker',
        seq: seq + 1,
        role: 'node-attempt',
        slotKey: encodeCanonicalRunSlot(slot),
        generationSeq: 0,
        attemptIndex: seq,
        recordMode: 'executable',
        provenanceQuality: 'recorded',
        envelopeNonce: `nonce-${id}`,
        status: 'pending',
      })
  }
  const participant = createRunSelectionParticipantInTx(() => 23)
  test('insert, stale CAS, clear tombstone and reselect keep monotonically increasing revisions', async () => {
    await seed()
    const reader = createRunSelectionReader(h.db)
    expect(await reader.revision('t', slot)).toBe(0)
    expect(await transaction((tx) => participant.apply(tx, [change('r1', 0)]))).toEqual([
      { taskId: 't', slot, revision: 1, generationSeq: 0, selectedRunId: 'r1' },
    ])
    await expect(transaction((tx) => participant.apply(tx, [change('r2', 0)]))).rejects.toThrow(
      'changed concurrently',
    )
    await transaction((tx) =>
      participant.apply(tx, [
        { kind: 'clear', taskId: 't', slot, expectedRevision: 1, generationSeq: 1, cause: 'clear' },
      ]),
    )
    expect(await createRunSelectionReader(h.db).current('t', slot)).toBeNull()
    const { nodeRunSelections } = tablesOf(h.db)
    expect((await h.db.select().from(nodeRunSelections))[0]).toMatchObject({
      revision: 2,
      selectedRunId: null,
      generationSeq: 1,
      selectedAt: 23,
    })
    await expect(transaction((tx) => participant.apply(tx, [change('r2', 0)]))).rejects.toThrow(
      'changed concurrently',
    )
    const clearedRevision = await reader.revision('t', slot)
    expect(clearedRevision).toBe(2)
    await transaction((tx) => participant.apply(tx, [change('r2', clearedRevision, 1)]))
    expect(await createRunSelectionReader(h.db).current('t', slot)).toMatchObject({
      id: 'r2',
      revision: 3,
    })
  })
  test('failed second change rolls back prior selection and companion writes', async () => {
    await seed()
    await expect(
      transaction(async (tx) => {
        await writeNodeRunTablesInTx(tx, 'r1', { result: { tokTotal: 42 } })
        await participant.apply(tx, [change('r1', 0), change('r2', 0)])
      }),
    ).rejects.toThrow('changed concurrently')
    const { nodeRunSelections, nodeRunResults } = tablesOf(h.db)
    expect(await h.db.select().from(nodeRunSelections)).toEqual([])
    expect(await h.db.select().from(nodeRunResults)).toEqual([])
  })
  test('owner sees selection before commit and outer rollback removes it', async () => {
    await seed()
    await expect(
      transaction(async (tx) => {
        await participant.apply(tx, [change('r1', 0)])
        expect(await createRunSelectionReader(tx).current('t', slot)).toMatchObject({
          id: 'r1',
          revision: 1,
        })
        throw new Error('owner-cas-missed')
      }),
    ).rejects.toThrow('owner-cas-missed')
    expect(await createRunSelectionReader(h.db).current('t', slot)).toBeNull()
  })
  test('competing revision-zero writers have exactly one winner', async () => {
    await seed()
    const results = await Promise.allSettled(
      ['r1', 'r2'].map((id) => transaction((tx) => participant.apply(tx, [change(id, 0)]))),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    expect((await createRunSelectionReader(h.db).current('t', slot))?.revision).toBe(1)
  })
  test('persistent identity, history mode and generation are checked before selection', async () => {
    await seed()
    await expect(transaction((tx) => participant.apply(tx, [change('r1', 0, 99)]))).rejects.toThrow(
      'selection-generation-missing',
    )
    const wrong: SelectionChange = {
      ...change('r1', 0),
      slot: { kind: 'node', nodeId: 'other', frame: { containerRunId: null, iteration: 0 } },
    }
    await expect(transaction((tx) => participant.apply(tx, [wrong]))).rejects.toThrow(
      'selection-run-slot-mismatch',
    )
    await insertHistoryRun()
    await expect(
      transaction((tx) => participant.apply(tx, [change('history', 0)])),
    ).rejects.toThrow('selection-history-only')
    expect(await createRunSelectionReader(h.db).current('t', slot)).toBeNull()
  })
  test.each(['slot', 'parent', 'container', 'shard'] as const)(
    'a self-consistent request still rejects a stored %s identity mismatch',
    async (field) => {
      await seed()
      const original = change('r1', 0)
      if (original.kind !== 'select') throw new Error('select-fixture-required')
      const claimedSlot: RunSlot =
        field === 'slot'
          ? { kind: 'node', nodeId: 'other', frame: { containerRunId: null, iteration: 0 } }
          : slot
      const claimed: SelectionChange = {
        ...original,
        slot: claimedSlot,
        run: {
          ...original.run,
          slot: claimedSlot,
          parentNodeRunId: field === 'parent' ? 'r2' : null,
          containerRunId: field === 'container' ? 'r2' : null,
          shardKey: field === 'shard' ? '' : null,
        },
      }
      expect(() => validateSelectionChange(claimed)).not.toThrow()
      await expect(transaction((tx) => participant.apply(tx, [claimed]))).rejects.toThrow(
        'selection-run-slot-mismatch',
      )
      expect(await h.db.select().from(tablesOf(h.db).nodeRunSelections)).toEqual([])
    },
  )
  test('clear of an absent slot exposes its revision for the first selection', async () => {
    await seed()
    const reader = createRunSelectionReader(h.db)
    await transaction(async (tx) => {
      await participant.apply(tx, [
        {
          kind: 'clear',
          taskId: 't',
          slot,
          expectedRevision: await createRunSelectionReader(tx).revision('t', slot),
          generationSeq: 0,
          cause: 'clear-empty',
        },
      ])
    })
    expect(await reader.current('t', slot)).toBeNull()
    const revision = await reader.revision('t', slot)
    expect(revision).toBe(1)
    await transaction((tx) => participant.apply(tx, [change('r1', revision)]))
    expect(await reader.current('t', slot)).toMatchObject({ id: 'r1', revision: 2 })
  })
  test('unknown unrelated history does not block a known family and clear never falls back to history', async () => {
    await seed()
    const { nodeRuns } = tablesOf(h.db)
    await insertOne(h.db, nodeRuns, {
      id: 'unknown',
      taskId: 't',
      nodeId: 'unknown',
      seq: 99,
      generationSeq: 0,
      role: null,
      slotKey: null,
      attemptIndex: null,
      scopePath: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
      status: 'done',
    })
    await transaction((tx) => participant.apply(tx, [change('r1', 0)]))
    const reader = createRunSelectionReader(h.db)
    expect((await reader.familyHistory('t', { runIds: ['r1'] })).map((row) => row.id)).toEqual([
      'r1',
    ])
    expect((await reader.familyHistory('t', {})).map((row) => row.id)).toEqual([
      'r1',
      'r2',
      'unknown',
    ])
    expect(await reader.familyHistory('t', { nodeId: 'unknown' })).toMatchObject([
      {
        id: 'unknown',
        identity: 'unknown',
        recordMode: 'history-only',
        role: null,
        slot: null,
        retryIndex: null,
      },
    ])
    await transaction((tx) =>
      participant.apply(tx, [
        { kind: 'clear', taskId: 't', slot, expectedRevision: 1, generationSeq: 0, cause: 'clear' },
      ]),
    )
    expect(await reader.current('t', slot)).toBeNull()
    expect(
      (await reader.currentInFrame('t', { containerRunId: null, iteration: 0 })).has('worker'),
    ).toBe(false)
  })
  test('partially known slot history and shard history retain nullable identity without enabling reuse', async () => {
    await seed()
    const shard: RunSlot = { kind: 'shard', nodeId: 'worker', iteration: 0, shardKey: '' }
    const { nodeRuns, nodeRunRuntimeStates } = tablesOf(h.db)
    await insertOne(h.db, nodeRuns, {
      id: 'partial',
      taskId: 't',
      nodeId: 'worker',
      seq: 4,
      generationSeq: 0,
      role: null,
      slotKey: encodeCanonicalRunSlot(shard),
      attemptIndex: null,
      shardKey: '',
      scopePath: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
      status: 'done',
    })
    await insertOne(h.db, nodeRunRuntimeStates, { nodeRunId: 'partial', mergeState: 'merged' })
    await insertOne(h.db, nodeRuns, {
      id: 'unknown-shard',
      taskId: 't',
      nodeId: 'worker',
      seq: 5,
      generationSeq: 0,
      role: null,
      slotKey: null,
      attemptIndex: null,
      shardKey: '',
      scopePath: null,
      recordMode: 'history-only',
      provenanceQuality: 'unknown',
      envelopeNonce: null,
      status: 'failed',
    })
    const reader = createRunSelectionReader(h.db)
    expect((await reader.familyHistory('t', { nodeId: 'worker' })).map((row) => row.id)).toEqual([
      'r1',
      'r2',
      'partial',
      'unknown-shard',
    ])
    expect(await reader.slotHistory('t', shard)).toMatchObject([
      {
        id: 'partial',
        identity: 'unknown',
        slot: shard,
        role: null,
        retryIndex: null,
      },
    ])
    const view = await reader.shardSet('t', {
      wrapperRunId: 'wrapper',
      iteration: 0,
      shards: [{ nodeId: 'worker', shardKey: '', valueHash: null }],
    })
    expect(view.history).toMatchObject([
      {
        id: 'partial',
        identity: 'unknown',
        slot: shard,
        role: null,
        retryIndex: null,
      },
      {
        id: 'unknown-shard',
        identity: 'unknown',
        slot: null,
        role: null,
        retryIndex: null,
      },
    ])
    expect(view.shards[0]).toMatchObject({
      current: null,
      reusable: null,
      singleMergedCandidate: null,
      replayable: false,
      rerunInPlace: false,
    })
    expect(view.participating).toEqual([])
  })
  test('migration may retain a known terminal history selection without making it resumable', async () => {
    await seed()
    const { nodeRunSelections } = tablesOf(h.db)
    await insertHistoryRun()
    await insertOne(h.db, nodeRunSelections, {
      taskId: 't',
      slotKey: encodeCanonicalRunSlot(slot),
      selectedRunId: 'history',
      revision: 1,
      generationSeq: 0,
      cause: 'legacy-epoch1',
      selectedAt: 1,
    })
    expect(await createRunSelectionReader(h.db).current('t', slot)).toBeNull()
    expect(
      (await createRunSelectionReader(h.db).slotHistory('t', slot)).map((run) => run.id),
    ).toEqual(['r1', 'r2', 'history'])
    for (const probe of readOnlyProbes) {
      const result = await probe.run({
        provider: h.capabilities.provider,
        query: async (statement) => rawRows(h.db, sql.raw(statement)),
      })
      expect(result).toEqual({ id: probe.id, passed: true, detail: { violations: 0 } })
    }
  })
})
