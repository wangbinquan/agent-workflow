// RFC-395 A3 K8: independent frozen HEAD SQL and dispatch branches. Do not import
// executable oracle helpers into an expectation, including its legacyPickers.
import { expect, setDefaultTimeout, test } from 'bun:test'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/migration/oracle/reader'
import { createNodeRunQueries } from '@/modules/task-execution/infrastructure/nodeRunQueries'
import { FROZEN_MIGRATIONS } from './migration-freeze'
import { seedSelectionFamilies as seedLiveSelectionFamilies } from './helpers/model/runSelectionSeed'
import {
  frozenS6 as projectedS6,
  frozenS7 as projectedS7,
} from './helpers/model/frozenSelection/repositoryPreparation'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/migration/oracle/rows'
import type { WrapperSlotRef } from '@/modules/task-execution/application/ports/runSelection'
import { describeEachProvider } from './helpers/eachProvider'
import { seedSelectionFamilies } from './helpers/model/frozenSelection/seed'
import { frozenS6, frozenS7 } from './helpers/model/frozenSelection/epoch1RepositoryPreparation'
import {
  frozenShardDecision,
  frozenAggregatorDecision,
} from './helpers/model/frozenSelection/fanout'
import { compareNodeRunMintOrder } from './helpers/model/frozenSelection/order'
import { pickFreshestRun, parseConsumedJson } from './helpers/model/frozenSelection/pickers'

// Seeded PostgreSQL rankings after sequence materialization take about 2.7 s on CI (run 40298205725)
// and timed out at 5448.71 ms in a CI-equivalent local run; allow 10 s.
setDefaultTimeout(10_000)

async function expectFanout(
  rows: readonly OracleRunRow[],
  taskId: string,
  request: WrapperSlotRef,
) {
  const view = await createRunSelectionOracleSnapshot(rows, { scope: { kind: 'rows' } }).shardSet(
    taskId,
    request,
  )
  const expected = request.shards.map((shard) =>
    frozenShardDecision(rows, { ...request, ...shard }),
  )
  const participating = expected.flatMap((row) => (row.input === undefined ? [] : [row.input]))
  for (const [index, shard] of expected.entries()) {
    const actual = view.shards[index]!
    expect(actual.current?.id).toBe(shard.current)
    expect(actual.reusable?.id).toBe(shard.reusable)
    expect(actual.replayable).toBe(shard.replayable)
    expect(actual.rerunInPlace).toBe(shard.rerunInPlace)
    expect(actual.singleMergedCandidate?.id).toBe(shard.singleMergedCandidate)
  }
  expect(view.participating.map((row) => row.id)).toEqual(participating.map((row) => row.id))
  const agg =
    request.aggregatorNodeId === undefined
      ? undefined
      : frozenAggregatorDecision(rows, participating, {
          ...request,
          nodeId: request.aggregatorNodeId,
        })
  expect(view.aggregator?.id).toBe(agg?.current)
  expect(view.aggregatorNewerThanInputs).toBe(agg?.newerThanInputs ?? false)
  expect(view.aggregatorReplayable).toBe(agg?.replayable ?? false)
  expect(view.aggregatorRerunInPlace).toBe(agg?.rerunInPlace ?? false)
  const recorded = parseConsumedJson(
    rows.find((row) => row.id === agg?.current)?.consumedUpstreamRunsJson,
  )
  expect(view.aggregatorInputs).toEqual(
    Object.entries(recorded).map(([producerNodeId, producerRunId]) => ({
      producerNodeId,
      producerRunId,
    })),
  )
  expect(view.aggregatorInputEvidence).toBe(
    Object.keys(recorded).length === 0 ? 'unrecorded' : 'source-node',
  )
}

describeEachProvider(
  'RFC-395 A3 extended seeded evidence',
  (harness) => {
    test.each([7, 395, 20261023])(
      'seed %i covers fanout, host, synthetic and NULL sequence histories',
      async (seed) => {
        expect(await frozenS6({ deps: { db: harness.db } }, 'missing')).toBeUndefined()
        expect(await frozenS7({ db: harness.db }, 'missing')).toBeUndefined()
        const { taskIds, generations, histories, cases } = await seedSelectionFamilies(
          harness.db,
          seed,
        )
        const reader = createRunSelectionReader(harness.db)
        for (const entry of cases) {
          const rows = histories.find((history) => history.taskId === entry.taskId)!.rows
          // Writer-owned membership is independent of oracle labels. HEAD #70 groups
          // host + gate by node/shard; compare that legacy query separately below.
          if (entry.slot.kind === 'workgroup-host') continue
          const candidates = rows.filter((row) => entry.runIds.includes(row.id))
          const current =
            entry.slot.kind === 'synthetic' && entry.slot.syntheticKind === 'repo-prep'
              ? await frozenS6({ deps: { db: harness.db } }, entry.taskId)
              : pickFreshestRun(candidates, { topLevelOnly: false })
          expect((await reader.current(entry.taskId, entry.slot))?.id).toBe(current?.id)
          expect((await reader.slotHistory(entry.taskId, entry.slot)).map((row) => row.id)).toEqual(
            [...candidates].sort(compareNodeRunMintOrder).map((row) => row.id),
          )
        }
        for (const history of histories) {
          const nullRows = history.rows.filter((row) => row.seq === null)
          expect(nullRows.length).toBeGreaterThanOrEqual(6)
          expect((await reader.familyHistory(history.taskId, {})).map((row) => row.id)).toEqual(
            [...history.rows].sort(compareNodeRunMintOrder).map((row) => row.id),
          )
        }
        const hostRows = histories.find((history) => history.taskId === taskIds.host)!.rows
        for (const nodeId of ['__wg_member__', '__wg_leader__'])
          for (const shardKey of [null, '', 'assignment', 'msg:1']) {
            const old = hostRows.filter((row) => row.nodeId === nodeId && row.shardKey === shardKey)
            expect(
              (await reader.familyHistory(taskIds.host, { nodeId, shardKey })).at(-1)?.id,
            ).toBe(pickFreshestRun(old, { topLevelOnly: false })?.id)
          }
        const dagRows = histories.find((history) => history.taskId === taskIds.dag)!.rows
        for (const iteration of [0, 1])
          for (const wrapperRunId of generations)
            for (const flags of [
              {},
              { reuseDisabled: true },
              { processRetryIndex: 0 },
              { reuseDisabled: true, processRetryIndex: 2 },
            ]) {
              await expectFanout(dagRows, taskIds.dag, {
                wrapperRunId,
                iteration,
                ...flags,
                aggregatorNodeId: 'agg',
                shards: [
                  ...['', 'a', 'b', 'missing'].map((shardKey) => ({
                    nodeId: 'inner',
                    shardKey,
                    valueHash: 'hash-a',
                  })),
                  { nodeId: 'shared', shardKey: null, valueHash: null },
                ],
              })
            }
        // The source keeps NULL seq; the separate live block below checks target projections.
        expect((await frozenS6({ deps: { db: harness.db } }, taskIds.dag))?.id).toBe(
          (await frozenS7({ db: harness.db }, taskIds.dag))?.id,
        )
      },
      60_000,
    )
  },
  { sqliteMigrationsFolder: FROZEN_MIGRATIONS },
)

function row(id: string, changes: Partial<OracleRunRow> = {}): OracleRunRow {
  return {
    id,
    taskId: 't',
    nodeId: 'inner',
    seq: 1,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: 'g0',
    containerRunId: 'g0',
    shardKey: 'a',
    shardValueHash: 'h',
    reviewIteration: 0,
    wgRound: null,
    rerunCause: 'fanout-shard',
    wrapperProgressJson: null,
    consumedUpstreamRunsJson: null,
    childTaskId: null,
    startedAt: null,
    mergeState: null,
    supersededByReview: null,
    ...changes,
  }
}

test('frozen fanout branches cover replay merge-state, status, hash, generation, NULL seq, zero/one/multiple merged predecessors', async () => {
  for (const mergeState of [
    null,
    'merged',
    'conflict-human',
    'pending-merge',
    'isolating',
    'merge-failed',
  ])
    for (const status of ['done', 'failed', 'interrupted'] as const)
      for (const parentNodeRunId of ['g0', 'g1'])
        for (const shardValueHash of [null, 'h', 'mismatch'])
          for (const legacy of [false, true]) {
            const shard = row('z-shard', {
              status,
              mergeState,
              parentNodeRunId,
              containerRunId: parentNodeRunId,
              shardValueHash,
              seq: legacy ? null : 10,
            })
            const agg = row('z-agg', {
              nodeId: 'agg',
              shardKey: null,
              rerunCause: 'fanout-aggregator',
              status,
              mergeState,
              parentNodeRunId,
              containerRunId: parentNodeRunId,
              seq: legacy ? null : 20,
            })
            for (const flags of [{}, { reuseDisabled: true }, { processRetryIndex: 0 }]) {
              await expectFanout([shard, agg], 't', {
                wrapperRunId: 'g1',
                iteration: 0,
                ...flags,
                shards: [{ nodeId: 'inner', shardKey: 'a', valueHash: 'h' }],
                aggregatorNodeId: 'agg',
              })
            }
          }
  for (const count of [0, 1, 2]) {
    const predecessors = Array.from({ length: count }, (_, index) =>
      row(`merged-${index}`, { seq: index + 1, mergeState: 'merged' }),
    )
    const rows = [
      ...predecessors,
      row('failed-newest', {
        status: 'failed',
        seq: 20,
        parentNodeRunId: 'g1',
        containerRunId: 'g1',
      }),
    ]
    await expectFanout(rows, 't', {
      wrapperRunId: 'g1',
      iteration: 0,
      shards: [{ nodeId: 'inner', shardKey: 'a', valueHash: 'h' }],
    })
  }
  // A done aggregator older than an input cannot replay, even with a settled merge.
  for (const consumedUpstreamRunsJson of [null, '', 'bad', '{}', '{"inner":"new-input"}']) {
    await expectFanout(
      [
        row('new-input', { seq: 50 }),
        row('old-agg', {
          nodeId: 'agg',
          shardKey: null,
          seq: 20,
          rerunCause: 'fanout-aggregator',
          consumedUpstreamRunsJson,
          mergeState: 'merged',
        }),
      ],
      't',
      {
        wrapperRunId: 'g1',
        iteration: 0,
        shards: [{ nodeId: 'inner', shardKey: 'a', valueHash: 'h' }],
        aggregatorNodeId: 'agg',
      },
    )
  }
})

// The same retained narrow reads are exercised against the activated factories.
describeEachProvider('RFC-395 activated repository-preparation projections', (harness) => {
  test.each([7, 395, 20261023])(
    'seed %i keeps S6/S7 rankings after sequence materialization',
    async (seed) => {
      const { taskIds } = await seedLiveSelectionFamilies(harness.db, seed)
      // The actual migrated S6 / S7 narrow reads and the selection oracle both
      // compare with the two distinct frozen SQL statements, including NULL seq.
      const s6 = await projectedS6({ deps: { db: harness.db } }, taskIds.dag)
      const s7 = await projectedS7({ db: harness.db }, taskIds.dag)
      expect(s6?.id).toBe(s7?.id)
      const queries = createNodeRunQueries(harness.db)
      expect(
        (
          await queries.listFields(
            { taskId: taskIds.dag, nodeId: '__repo_prep__', order: 'retry-desc', limit: 1 },
            ['id'],
          )
        )[0],
      ).toEqual(s6)
      const selectedPrep = (
        await queries.listFields(
          { taskId: taskIds.dag, nodeId: '__repo_prep__', order: 'retry-desc', limit: 1 },
          ['id', 'retryIndex', 'status'],
        )
      )[0]
      if (s7 === undefined || s7.retryIndex === null)
        throw new Error('frozen-repository-preparation-identity-missing')
      expect(selectedPrep?.id).toBe(s7.id)
      expect(selectedPrep?.retryIndex).toBe(s7.retryIndex)
      expect(selectedPrep?.status).toBe(s7.status)
    },
  )
})
