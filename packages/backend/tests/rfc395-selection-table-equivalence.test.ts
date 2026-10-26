// RFC-395 N-a: independent persisted choices versus the frozen epoch-1 oracle.
import { expect, test } from 'bun:test'
import { DrizzleWrapperRunPersistence } from '@/modules/task-execution/infrastructure/wrapperRunPersistence'
import { patchNodeRunFixture } from './helpers/model'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { insertOne } from '@/platform/persistence/singleInsert'
import type {
  RunSlot,
  HistoryFilter,
} from '@/modules/task-execution/application/ports/runSelection'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/runSelection/table/reader'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/runSelection/table/selectionWrite'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/migration/oracle/rows'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import { encodeSyntheticOwner } from '@/modules/task-execution/domain/runSelection/syntheticOwner'
import { producerShardSlot } from '@/modules/task-execution/domain/runInputShard'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { recordNodeRunInputsInTx } from '@/modules/task-execution/infrastructure/consumedInputsParticipant'
import { taskAggregateWrite } from '@/modules/task-execution/infrastructure/taskDefinitionWriteParticipant'
import { describeEachProvider } from './helpers/eachProvider'
import { taskFixture, workflowFixture } from './helpers/model'

interface Entry {
  readonly row: OracleRunRow & { readonly seq: number }
  readonly slot: RunSlot
  readonly generationSeq?: number
}
function random(seed: number) {
  let value = seed >>> 0
  return (max: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return (value >>> 8) % max
  }
}
function entry(id: string, seq: number, slot: RunSlot, patch: Partial<OracleRunRow> = {}): Entry {
  const row = {
    id,
    taskId: 't',
    nodeId: slot.kind === 'synthetic' ? slot.discriminator : slot.nodeId,
    seq,
    status: 'done' as const,
    retryIndex: 0,
    iteration:
      slot.kind === 'node' || slot.kind === 'container'
        ? slot.frame.iteration
        : 'iteration' in slot
          ? slot.iteration
          : 0,
    parentNodeRunId: null,
    containerRunId:
      slot.kind === 'node' || slot.kind === 'container' ? slot.frame.containerRunId : null,
    shardKey: 'shardKey' in slot ? slot.shardKey : null,
    shardValueHash: null,
    reviewIteration: 0,
    wgRound: null,
    rerunCause:
      slot.kind === 'container'
        ? 'wrapper-init'
        : slot.kind === 'shard'
          ? 'fanout-shard'
          : slot.kind === 'aggregator'
            ? 'fanout-aggregator'
            : null,
    wrapperProgressJson: null,
    consumedUpstreamRunsJson: null,
    childTaskId: null,
    startedAt: null,
    mergeState: null,
    supersededByReview: null,
    ...patch,
  }
  if (row.seq === null) throw new Error('fixture-needs-materialized-seq')
  return { row: { ...row, seq: row.seq }, slot }
}
const frame = { containerRunId: null, iteration: 0 }
const container: RunSlot = { kind: 'container', nodeId: 'wrapper', frame }
const prep: RunSlot = {
  kind: 'synthetic',
  owner: { kind: 'task', id: 't' },
  syntheticKind: 'repo-prep',
  discriminator: '__repo_prep__',
}
const normalize = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (key, entry: unknown) => (key === 'revision' ? null : entry)),
  ) as unknown

async function install(db: PersistenceDb, entries: readonly Entry[]) {
  const definition = {
    $schema_version: 2,
    nodes: [
      { id: 'wrapper', kind: 'wrapper-fanout', nodeIds: ['inner', 'shared', 'agg'] },
      { id: 'worker', kind: 'agent-single', agentName: 'worker' },
    ],
    edges: [],
    inputs: [],
  }
  await workflowFixture(db, { id: 'w', name: 'w', definition })
  await taskFixture(db, {
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
  const {
    nodeRuns,
    nodeRunConfigs,
    nodeRunRuntimeStates,
    nodeRunResults,
    nodeRunInputs,
    taskExecutionGenerations,
  } = tablesOf(db)
  for (const generationSeq of [...new Set(entries.map((value) => value.generationSeq ?? 0))].sort(
    (a, b) => a - b,
  )) {
    if (generationSeq === 0) continue
    await insertOne(db, taskExecutionGenerations, {
      taskId: 't',
      generationSeq,
      previousGenerationSeq: generationSeq - 1,
      cause: 'retry',
      operationRef: `retry-${generationSeq}`,
      createdAt: generationSeq,
    })
  }
  // Raw target rows deliberately pin the physical oracle comparison boundary;
  // fixtures do not derive expected role/slot or choose the persisted winner.
  for (const { row, slot, generationSeq = 0 } of entries) {
    const role =
      slot.kind === 'container'
        ? 'container'
        : slot.kind === 'synthetic' || slot.kind === 'workgroup-host'
          ? 'synthetic'
          : 'node-attempt'
    await insertOne(db, nodeRuns, {
      id: row.id,
      taskId: row.taskId,
      nodeId: row.nodeId,
      seq: row.seq,
      role,
      syntheticOwner:
        role !== 'synthetic'
          ? null
          : encodeSyntheticOwner(
              slot.kind === 'synthetic' ? slot.owner : { kind: 'task', id: 't' },
            ),
      slotKey: encodeCanonicalRunSlot(slot),
      generationSeq,
      attemptIndex: row.retryIndex,
      status: row.status,
      historicalParentId: row.parentNodeRunId,
      containerRunId: row.containerRunId,
      iteration: row.iteration,
      shardKey: row.shardKey,
      reviewIteration: row.reviewIteration,
      wgRound: row.wgRound,
      rerunCause: row.rerunCause,
      childTaskId: row.childTaskId,
      startedAt: row.startedAt,
      recordMode: 'executable',
      provenanceQuality: 'recorded',
      envelopeNonce: `nonce-${row.id}`,
      inputsRecorded: row.consumedUpstreamRunsJson !== null,
    })
    if (row.shardValueHash !== null)
      await insertOne(db, nodeRunConfigs, { nodeRunId: row.id, shardValueHash: row.shardValueHash })
    if (row.mergeState !== null || row.wrapperProgressJson !== null)
      await insertOne(db, nodeRunRuntimeStates, {
        nodeRunId: row.id,
        mergeState: row.mergeState,
        wrapperProgressJson: row.wrapperProgressJson,
      })
    if (row.supersededByReview !== null)
      await insertOne(db, nodeRunResults, {
        nodeRunId: row.id,
        supersededByReview: row.supersededByReview,
      })
  }
  for (const { row } of entries) {
    const edges = Object.entries(
      JSON.parse(row.consumedUpstreamRunsJson ?? '{}') as Record<string, string>,
    )
    for (const [ordinal, [producerNodeId, producerRunId]] of edges.entries()) {
      const producer = entries.find((candidate) => candidate.row.id === producerRunId)!.row
      await insertOne(db, nodeRunInputs, {
        taskId: 't',
        consumerRunId: row.id,
        ordinal,
        producerNodeId,
        producerRunId,
        producerRunRef: producerRunId,
        inputKind: 'frame-input',
        producerShardSlot: producerShardSlot(producer.shardKey),
      })
    }
  }
  const groups = new Map<string, Entry[]>()
  for (const candidate of entries) {
    const key = encodeCanonicalRunSlot(candidate.slot)
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  }
  await databaseSessionFor(db).transaction(async (tx) => {
    await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
    const participant = createRunSelectionParticipantInTx()
    for (const values of groups.values()) {
      const chosen = [...values]
        .sort(
          (a, b) =>
            (a.slot.kind === 'synthetic' && a.slot.syntheticKind === 'repo-prep'
              ? a.row.retryIndex - b.row.retryIndex
              : 0) || a.row.seq - b.row.seq,
        )
        .at(-1)!
      await participant.apply(tx, [
        {
          kind: 'select',
          taskId: 't',
          slot: chosen.slot,
          run: { ...chosen.row, slot: chosen.slot },
          expectedRevision: 0,
          generationSeq: chosen.generationSeq ?? 0,
          cause: 'legacy-epoch1',
        },
      ])
    }
  })
  return groups
}

describeEachProvider('RFC-395 table versus frozen oracle', (h) => {
  test.each([7, 395, 20261023])(
    'seed %i: six slot families, frame/history filters and shard decisions',
    async (seed) => {
      const next = random(seed)
      const entries: Entry[] = [
        entry('g0', -30, container),
        entry('g1', -20, container),
        entry('upstream', -10, { kind: 'node', nodeId: 'upstream', frame }),
      ]
      const statuses = [
        'done',
        'failed',
        'interrupted',
        'pending',
        'canceled',
        'running',
        'skipped',
        'exhausted',
      ] as const
      const merges = [
        null,
        'merged',
        'conflict-human',
        'pending-merge',
        'isolating',
        'merge-failed',
      ] as const
      for (let index = 0; index < 72; index++) {
        const iteration = next(2)
        const parent = next(2) ? 'g1' : 'g0'
        const category = index % 6
        const slot: RunSlot =
          category === 0
            ? { kind: 'node', nodeId: 'worker', frame: { containerRunId: parent, iteration } }
            : category === 1
              ? { kind: 'shard', nodeId: 'inner', shardKey: ['', 'a', 'b'][next(3)]!, iteration }
              : category === 2
                ? { kind: 'shard', nodeId: 'shared', shardKey: null, iteration }
                : category === 3
                  ? { kind: 'aggregator', nodeId: 'agg', iteration }
                  : category === 4
                    ? prep
                    : {
                        kind: 'workgroup-host',
                        nodeId: '__wg_member__',
                        shardKey: [null, '', 'assignment', 'msg:1'][next(4)]!,
                      }
        entries.push(
          entry(`r-${(index * 37) % 73}`, index, slot, {
            status: statuses[next(statuses.length)]!,
            retryIndex: next(7),
            startedAt: next(3) === 0 ? null : next(50),
            mergeState: merges[next(merges.length)]!,
            reviewIteration: next(4),
            ...(slot.kind === 'shard' || slot.kind === 'aggregator'
              ? {
                  parentNodeRunId: parent,
                  containerRunId: parent,
                  shardValueHash: next(2) ? 'h' : null,
                }
              : {}),
            ...(slot.kind === 'workgroup-host' ? { wgRound: next(4) } : {}),
            ...(slot.kind === 'node'
              ? { consumedUpstreamRunsJson: next(2) ? '{"upstream":"upstream"}' : '{}' }
              : {}),
          }),
        )
      }
      const groups = await install(h.db, entries)
      const oracle = createRunSelectionOracleSnapshot(entries.map(({ row }) => row))
      const table = createRunSelectionReader(h.db)
      const filters: HistoryFilter[] = [
        {},
        { direction: 'desc' },
        { excludeSuperseded: true },
        { consumedOnly: true },
        { order: 'retry-index' },
        { order: 'api-timeline' },
        { order: 'started-at' },
        { order: 'iteration' },
        { order: 'running-first' },
        { statusIn: ['done', 'skipped'] },
        { attemptIndexGreaterThan: 2 },
        { topLevelOnly: true },
        { childOnly: true },
        { through: { id: 'unused', seq: 30 }, after: { id: 'unused', seq: -1 } },
      ]
      expect(new Set(entries.map(({ slot }) => slot.kind)).size).toBe(6)
      for (const group of groups.values()) {
        const slot = group[0]!.slot
        expect(normalize(await table.current('t', slot))).toEqual(
          normalize(await oracle.current('t', slot)),
        )
        for (const filter of filters)
          expect(await table.slotHistory('t', slot, filter)).toEqual(
            await oracle.slotHistory('t', slot, filter),
          )
      }
      for (const filter of filters)
        expect(
          await table.familyHistory('t', { nodeIds: ['worker', 'inner'], iteration: 1 }, filter),
        ).toEqual(
          await oracle.familyHistory('t', { nodeIds: ['worker', 'inner'], iteration: 1 }, filter),
        )
      for (const containerRunId of [null, 'g0', 'g1'])
        for (const iteration of [0, 1]) {
          const frame = { containerRunId, iteration }
          expect(
            normalize(
              [...(await table.currentInFrame('t', frame))].sort(([a], [b]) => a.localeCompare(b)),
            ),
          ).toEqual(
            normalize(
              [...(await oracle.currentInFrame('t', frame))].sort(([a], [b]) => a.localeCompare(b)),
            ),
          )
        }
      for (const { row } of entries)
        expect(await table.consumed(row.id)).toEqual(await oracle.consumed(row.id))
      for (const wrapperRunId of ['g0', 'g1'])
        for (const iteration of [0, 1])
          for (const flags of [{}, { reuseDisabled: true }, { processRetryIndex: 0 }]) {
            const request = {
              wrapperRunId,
              iteration,
              ...flags,
              aggregatorNodeId: 'agg',
              shards: [
                { nodeId: 'shared', shardKey: null, valueHash: null },
                ...['', 'a', 'b'].map((shardKey) => ({
                  nodeId: 'inner',
                  shardKey,
                  valueHash: 'h',
                })),
              ],
            }
            const { history, ...selection } = await table.shardSet('t', request)
            expect(history.length).toBeGreaterThan(0)
            expect(normalize(selection)).toEqual(normalize(await oracle.shardSet('t', request)))
          }
    },
    90_000,
  )

  test('repo-prep retry priority survives a newer low-retry row', async () => {
    const entries = [
      entry('high-retry', 1, prep, { retryIndex: 9 }),
      entry('newer', 2, prep, { retryIndex: 0 }),
    ]
    await install(h.db, entries)
    const table = createRunSelectionReader(h.db)
    expect((await table.current('t', prep))?.id).toBe('high-retry')
    expect((await table.currentInFrame('t', frame)).get('__repo_prep__')?.id).toBe('newer')
    expect(normalize(await table.current('t', prep))).toEqual(
      normalize(
        await createRunSelectionOracleSnapshot(entries.map(({ row }) => row)).current('t', prep),
      ),
    )
  })
  test('cross-generation reuse and aggregator replay retain the old newer-than-input criterion', async () => {
    const shard: RunSlot = { kind: 'shard', nodeId: 'inner', shardKey: '', iteration: 0 }
    const aggregator: RunSlot = { kind: 'aggregator', nodeId: 'agg', iteration: 0 }
    const entries = [
      entry('g0', 1, container),
      entry('s0', 2, shard, {
        parentNodeRunId: 'g0',
        containerRunId: 'g0',
        shardValueHash: 'h',
        mergeState: 'merged',
      }),
      entry('a0', 3, aggregator, { parentNodeRunId: 'g0', containerRunId: 'g0' }),
      { ...entry('g1', 4, container, { status: 'pending' }), generationSeq: 1 },
    ]
    await install(h.db, entries)
    const table = createRunSelectionReader(h.db)
    const request = {
      wrapperRunId: 'g1',
      iteration: 0,
      aggregatorNodeId: 'agg',
      shards: [{ nodeId: 'inner', shardKey: '', valueHash: 'h' }],
    }
    const before = await table.shardSet('t', request)
    expect(before.shards[0]).toMatchObject({
      reusable: { id: 's0', structurallySuperseded: true },
      replayable: true,
    })
    expect(before.aggregatorReplayable).toBe(true)
    const { history, ...selection } = before
    expect(history.map((row) => row.id)).toEqual(['s0', 'a0'])
    expect(normalize(selection)).toEqual(
      normalize(
        await createRunSelectionOracleSnapshot(entries.map(({ row }) => row)).shardSet(
          't',
          request,
        ),
      ),
    )
    await h.session.transaction(async (tx) => {
      await taskAggregateWrite.lockTaskAggregateRoot(tx, 't')
      await recordNodeRunInputsInTx(tx, 'a0', [
        { producerNodeId: 'wrapper', producerRunId: 'g1', inputKind: 'aggregator-shard' },
      ])
    })
    const after = await table.shardSet('t', request)
    expect(after.aggregatorInputs).toEqual([{ producerNodeId: 'wrapper', producerRunId: 'g1' }])
    expect(after.aggregatorInputEvidence).toBe('aggregator-shard')
    expect(after.aggregatorNewerThanInputs).toBe(true)
    expect(after.aggregatorReplayable).toBe(true)
    expect(
      (await table.shardSet('t', { ...request, reuseDisabled: true })).aggregatorReplayable,
    ).toBe(false)
    expect(
      (await table.shardSet('t', { ...request, processRetryIndex: 0 })).aggregatorReplayable,
    ).toBe(false)
  })
  test('activated wrapper resumability follows selected identity and terminal transitions', async () => {
    await install(h.db, [
      entry('older', 1, container, { status: 'failed' }),
      entry('current', 2, container, { status: 'interrupted' }),
    ])
    const reader = createRunSelectionReader(h.db)
    const wrapper = new DrizzleWrapperRunPersistence(h.db)
    const input = { taskId: 't', nodeId: 'wrapper', containerRunId: null, iteration: 0 }
    expect((await wrapper.findResumable(input))?.id).toBe('current')
    expect((await reader.current('t', container))?.resumable).toBe(true)
    await patchNodeRunFixture(h.db, { id: 'current' }, { status: 'done' })
    expect(await wrapper.findResumable(input)).toBeNull()
    expect((await reader.current('t', container))?.resumable).toBe(false)
  })
})
