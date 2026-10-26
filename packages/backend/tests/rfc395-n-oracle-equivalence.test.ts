import { FROZEN_MIGRATIONS } from './migration-freeze'
import { patchNodeRunFixture } from './helpers/model/frozenSelection/storage'
// RFC-395 N-domain: derive membership independently, then materialize target selections.
// The frozen II-a predicates are expectations; executable oracle labels never supply facts.
import { expect, test } from 'bun:test'
import { deriveLegacyNodeRunIdentity } from '@/modules/task-execution/domain/runSelection/legacyIdentity'
import type {
  LegacyNodeRunFacts,
  LegacyNodeRunIdentity,
  LegacyRunWriterFact,
} from '@/modules/task-execution/domain/runSelection/legacyFacts'
import { encodeCanonicalRunSlot } from '@/modules/task-execution/domain/runSelection/slotKey'
import {
  runSlotInFamily,
  type RunFamily,
} from '@/modules/task-execution/domain/runSelection/families'
import { compareRunSequence } from '@/modules/task-execution/domain/runSelection/ordering'
import { planNodeRunSeqBackfill } from '@/modules/task-execution/infrastructure/migration/run/legacySequencePlan'
import { applySelectionChanges } from '@/modules/task-execution/domain/runSelection/changes'
import type { RunSlot } from '@/modules/task-execution/domain/runSelection/slots'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/migration/oracle/rows'
import { describeEachProvider } from './helpers/eachProvider'
import { seedSelectionFamilies, selectionRandom } from './helpers/model/frozenSelection/seed'
import { compareNodeRunMintOrder } from './helpers/model/frozenSelection/order'
import { isStructurallySuperseded } from './helpers/model/frozenSelection/supersession'
import {
  frozenShardDecision,
  frozenAggregatorDecision,
} from './helpers/model/frozenSelection/fanout'
import { frozenS6, frozenS7 } from './helpers/model/frozenSelection/epoch1RepositoryPreparation'
import ledger from './fixtures/rfc395-selection-semantics-ledger.json'

type SequencedRow = OracleRunRow & { readonly seq: number }
type Identified = {
  readonly row: SequencedRow
  readonly identity: LegacyNodeRunIdentity
  readonly slot: RunSlot
}

/** D3: oracle input is the result of today's boot backfill, including newer allocations. */
function materializedSequences(rows: readonly OracleRunRow[]): SequencedRow[] {
  let highWater = Math.max(0, ...rows.flatMap((row) => (row.seq === null ? [] : [row.seq])))
  const assigned = new Map<string, number>()
  for (const taskId of [...new Set(rows.map((row) => row.taskId))].sort()) {
    const taskRows = rows.filter((row) => row.taskId === taskId)
    const existing = taskRows.filter((row) => row.seq !== null)
    const missing = taskRows
      .filter((row) => row.seq === null)
      .map((row) => row.id)
      .sort()
    const plan = planNodeRunSeqBackfill(
      {
        minSeq: existing.length ? Math.min(...existing.map((row) => row.seq!)) : null,
        maxId: existing.length
          ? existing
              .map((row) => row.id)
              .sort()
              .at(-1)!
          : null,
      },
      missing,
    )
    if (plan.kind === 'initial')
      missing.forEach((id, index) => assigned.set(id, index - missing.length + 1))
    else {
      for (const row of plan.older) assigned.set(row.id, row.seq)
      for (const id of plan.newer) assigned.set(id, ++highWater)
    }
  }
  const result = rows.map((row) => ({ ...row, seq: row.seq ?? assigned.get(row.id)! }))
  expect(new Set(result.map((row) => JSON.stringify([row.taskId, row.seq]))).size).toBe(
    result.length,
  )
  expect(result.every((row) => Number.isSafeInteger(row.seq))).toBe(true)
  for (const row of rows)
    if (row.seq !== null) expect(result.find((entry) => entry.id === row.id)!.seq).toBe(row.seq)
  return result
}

function identify(
  rows: readonly SequencedRow[],
  facts: (row: SequencedRow) => LegacyNodeRunFacts,
): Identified[] {
  return rows.map((row) => {
    const identity = deriveLegacyNodeRunIdentity(row, facts(row))
    expect({
      id: row.id,
      mode: identity.recordMode,
      missing: identity.evidence.missingFacts,
      conflicts: identity.evidence.conflicts,
    }).toEqual({ id: row.id, mode: 'executable', missing: [], conflicts: [] })
    return { row, identity, slot: identity.slot! }
  })
}

function latestBySlot(rows: readonly Identified[]) {
  const selected = new Map<string, Identified>()
  for (const candidate of rows) {
    const key = encodeCanonicalRunSlot(candidate.slot)
    const previous = selected.get(key)
    if (previous === undefined || compareRunSequence(candidate.row, previous.row) > 0)
      selected.set(key, candidate)
  }
  const state = applySelectionChanges(
    [],
    [...selected.values()].map(({ row, slot }) => ({
      kind: 'select' as const,
      taskId: row.taskId,
      slot,
      expectedRevision: 0,
      generationSeq: 0,
      cause: 'legacy-materialization',
      run: {
        id: row.id,
        taskId: row.taskId,
        slot,
        containerRunId: row.containerRunId,
        parentNodeRunId: row.parentNodeRunId,
        shardKey: row.shardKey,
      },
    })),
  )
  return new Map(state.map((entry) => [encodeCanonicalRunSlot(entry.slot), entry.selectedRunId]))
}

function seedFacts(
  rows: readonly OracleRunRow[],
  taskIds: { dag: string; host: string; dw: string },
) {
  const byId = new Map(rows.map((row) => [row.id, row]))
  // These are the seed writer's identities, not a production name/cause classifier.
  const writer = (row: OracleRunRow): LegacyRunWriterFact | undefined => {
    const kind =
      row.taskId === taskIds.host
        ? 'workgroup-turn'
        : row.taskId === taskIds.dw
          ? 'dynamic-workflow'
          : row.nodeId === '__repo_prep__'
            ? 'repository-preparation'
            : row.rerunCause === 'commit-push'
              ? 'commit-push'
              : row.rerunCause === 'merge-resolve'
                ? 'merge-resolution'
                : undefined
    return kind === undefined
      ? undefined
      : {
          runId: row.id,
          taskId: row.taskId,
          writer: kind,
          evidence: [`runSelectionSeed-writer:${row.id}`],
        }
  }
  return (row: OracleRunRow): LegacyNodeRunFacts => {
    const parent = row.parentNodeRunId === null ? undefined : byId.get(row.parentNodeRunId)
    const container = row.containerRunId === null ? undefined : byId.get(row.containerRunId)
    return {
      task: {
        id: row.taskId,
        subject: row.taskId === taskIds.dag ? 'workflow' : 'workgroup',
        engine:
          row.taskId === taskIds.dag
            ? 'dag'
            : row.taskId === taskIds.host
              ? 'workgroup-turns'
              : 'dw-generate',
        definition: {
          nodes:
            row.taskId === taskIds.dag
              ? [
                  { id: 'wrapper', kind: 'wrapper-fanout', nodeIds: ['inner', 'shared', 'agg'] },
                  ...['inner', 'shared', 'agg', 'ordinary'].map((id) => ({
                    id,
                    kind: 'agent-single' as const,
                  })),
                ]
              : [],
        },
        fanouts: [
          {
            wrapperNodeId: 'wrapper',
            perShardNodeIds: ['inner'],
            sharedNodeIds: ['shared'],
            aggregatorNodeId: 'agg',
            evidence: ['runSelectionSeed:frozen-fanout-and-agent-role'],
          },
        ],
      },
      writer: writer(row),
      parent: parent === undefined ? undefined : { row: parent, writer: writer(parent) },
      container: container === undefined ? undefined : { row: container },
    }
  }
}

describeEachProvider(
  'RFC-395 N-domain seeded canonical membership',
  (harness) => {
    test.each([7, 395, 20261023])(
      'seed %i: all six slot kinds, NULL seq and S6/S7 exception',
      async (seed) => {
        const seeded = await seedSelectionFamilies(harness.db, seed)
        const covered = new Set<string>()
        let repoPrepExceptions = 0
        for (const history of seeded.histories) {
          expect(history.rows.filter((row) => row.seq === null).length).toBeGreaterThanOrEqual(6)
          const sequenced = materializedSequences(history.rows)
          for (const row of sequenced)
            if (history.rows.find((source) => source.id === row.id)!.seq === null)
              await patchNodeRunFixture(harness.db, { id: row.id }, { seq: row.seq })
          const oracle = createRunSelectionOracleSnapshot(sequenced)
          const identified = identify(sequenced, seedFacts(sequenced, seeded.taskIds))
          const selections = latestBySlot(identified)
          for (const entry of seeded.cases.filter((entry) => entry.taskId === history.taskId)) {
            covered.add(entry.slot.kind)
            const key = encodeCanonicalRunSlot(entry.slot)
            const members = identified.filter(
              (candidate) => encodeCanonicalRunSlot(candidate.slot) === key,
            )
            expect(members.map(({ row }) => row.id).sort()).toEqual([...entry.runIds].sort())
            for (const candidate of members) {
              expect(candidate.slot).toEqual(entry.slot)
              const old = sequenced.find((row) => row.id === candidate.row.id)!
              expect(isStructurallySuperseded(candidate.row, sequenced)).toBe(
                isStructurallySuperseded(old, sequenced),
              )
            }
            // #70's old host query also admitted gates. Exact host membership uses only
            // the proved host rows; the full historical union is compared below.
            const exactHistory = (excludeSuperseded = false) =>
              entry.slot.kind === 'workgroup-host'
                ? oracle.familyHistory(
                    history.taskId,
                    { runIds: entry.runIds },
                    { excludeSuperseded },
                  )
                : oracle.slotHistory(history.taskId, entry.slot, { excludeSuperseded })
            const oldCurrent =
              entry.slot.kind === 'workgroup-host'
                ? ((await exactHistory()).at(-1)?.id ?? null)
                : ((await oracle.current(history.taskId, entry.slot))?.id ?? null)
            if (entry.slot.kind === 'synthetic' && entry.slot.syntheticKind === 'repo-prep') {
              const s6 = await frozenS6({ deps: { db: harness.db } }, history.taskId)
              const s7 = await frozenS7({ db: harness.db }, history.taskId)
              expect(oldCurrent).toBe(s6?.id ?? null)
              expect(s7?.id).toBe(s6?.id)
              // Existing A3 seeds deliberately violate retryIndex/seq monotonicity.
              // Do not hide this with reordered seq or a weakened equality assertion.
              expect(selections.get(key)).not.toBe(oldCurrent)
              repoPrepExceptions++
              const chosen = members.find(({ row }) => row.id === oldCurrent)!
              const initialized = applySelectionChanges(
                [],
                [
                  {
                    kind: 'select',
                    taskId: history.taskId,
                    slot: chosen.slot,
                    expectedRevision: 0,
                    generationSeq: 0,
                    cause: 'legacy-oracle-selection',
                    run: { ...chosen.row, slot: chosen.slot },
                  },
                ],
              )
              expect(initialized[0]!.selectedRunId).toBe(oldCurrent)
            } else expect(selections.get(key)).toBe(oldCurrent)
            const ordered = [...members].sort((a, b) => compareRunSequence(a.row, b.row))
            expect((await exactHistory()).map((row) => row.id)).toEqual(
              ordered.map(({ row }) => row.id),
            )
            expect((await exactHistory(true)).map((row) => row.id)).toEqual(
              ordered
                .filter(({ row }) => !isStructurallySuperseded(row, sequenced))
                .map(({ row }) => row.id),
            )
          }
          if (history.taskId === seeded.taskIds.host) {
            expect(ledger.sites.some((entry) => entry.reference === 'G5 #70-73/S11')).toBe(true)
            for (const nodeId of ['__wg_leader__', '__wg_member__'])
              for (const shardKey of [null, '', 'assignment', 'msg:1']) {
                const family: RunFamily = {
                  kind: 'workgroup',
                  taskId: history.taskId,
                  nodeId,
                  shardKey,
                }
                const union = identified
                  .filter(({ slot }) => runSlotInFamily(slot, family))
                  .sort((a, b) => compareRunSequence(a.row, b.row))
                expect(union.map(({ row }) => row.id)).toEqual(
                  (await oracle.familyHistory(history.taskId, { nodeId, shardKey })).map(
                    (row) => row.id,
                  ),
                )
                expect(
                  (
                    await oracle.current(history.taskId, {
                      kind: 'workgroup-host',
                      nodeId,
                      shardKey,
                    })
                  )?.id,
                ).toBe(union.at(-1)?.row.id)
                const budget = identified
                  .filter(({ slot }) => runSlotInFamily(slot, family, { legacyEmptyShard: true }))
                  .sort((a, b) => compareRunSequence(a.row, b.row))
                expect(budget.map(({ row }) => row.id)).toEqual(
                  [...sequenced]
                    .filter(
                      (row) => row.nodeId === nodeId && (row.shardKey ?? '') === (shardKey ?? ''),
                    )
                    .sort(compareNodeRunMintOrder)
                    .map((row) => row.id),
                )
              }
          }
          if (history.taskId === seeded.taskIds.dag) {
            for (const wrapperRunId of seeded.generations)
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
                        valueHash: 'hash-a',
                      })),
                    ],
                  }
                  const actual = await oracle.shardSet(history.taskId, request)
                  const participating: SequencedRow[] = []
                  for (const [index, shard] of request.shards.entries()) {
                    const slot: RunSlot = {
                      kind: 'shard',
                      nodeId: shard.nodeId,
                      iteration,
                      shardKey: shard.shardKey,
                    }
                    const members = identified
                      .filter(
                        (candidate) =>
                          encodeCanonicalRunSlot(candidate.slot) === encodeCanonicalRunSlot(slot),
                      )
                      .map(({ row }) => row)
                    const expected = frozenShardDecision(members, { ...request, ...shard })
                    if (expected.input !== undefined) participating.push(expected.input)
                    expect(actual.shards[index]!.current?.id).toBe(expected.current)
                    expect(actual.shards[index]!.reusable?.id).toBe(expected.reusable)
                    expect(actual.shards[index]!.replayable).toBe(expected.replayable)
                    expect(actual.shards[index]!.rerunInPlace).toBe(expected.rerunInPlace)
                    expect(actual.shards[index]!.singleMergedCandidate?.id).toBe(
                      expected.singleMergedCandidate,
                    )
                  }
                  const aggregator = frozenAggregatorDecision(
                    identified
                      .filter(({ slot }) => slot.kind === 'aggregator')
                      .map(({ row }) => row),
                    participating,
                    { ...request, nodeId: 'agg' },
                  )
                  expect(actual.participating.map((row) => row.id)).toEqual(
                    participating.map((row) => row.id),
                  )
                  expect(actual.aggregator?.id).toBe(aggregator.current)
                  expect(actual.aggregatorNewerThanInputs).toBe(aggregator.newerThanInputs)
                  expect(actual.aggregatorReplayable).toBe(aggregator.replayable)
                  expect(actual.aggregatorRerunInPlace).toBe(aggregator.rerunInPlace)
                  expect(actual.aggregatorInputs).toEqual([])
                  expect(actual.aggregatorInputEvidence).toBe('unrecorded')
                }
          }
        }
        expect([...covered].sort()).toEqual([
          'aggregator',
          'container',
          'node',
          'shard',
          'synthetic',
          'workgroup-host',
        ])
        expect(repoPrepExceptions).toBe(1)
      },
      60_000,
    )
  },
  { sqliteMigrationsFolder: FROZEN_MIGRATIONS },
)

function oracleRow(id: string, patch: Partial<OracleRunRow> = {}): OracleRunRow {
  return {
    id,
    taskId: 't',
    nodeId: 'review',
    seq: 1,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    parentNodeRunId: null,
    containerRunId: null,
    shardKey: null,
    shardValueHash: null,
    reviewIteration: 0,
    wgRound: null,
    rerunCause: null,
    wrapperProgressJson: null,
    consumedUpstreamRunsJson: null,
    childTaskId: null,
    startedAt: null,
    mergeState: null,
    supersededByReview: null,
    ...patch,
  }
}

test.each([7, 395, 20261023])(
  'seed %i: review rounds, placeholders, nested frames and registered familyHistory caliber',
  async (seed) => {
    const next = selectionRandom(seed)
    const rows: OracleRunRow[] = [
      oracleRow('g0', { nodeId: 'loop', seq: -10, status: 'pending', rerunCause: 'retry-node' }),
      oracleRow('g1', { nodeId: 'loop', seq: -9, status: 'pending', rerunCause: 'review-iterate' }),
    ]
    for (let index = 0; index < 48; index++)
      rows.push(
        oracleRow(`review-${index}`, {
          seq: index,
          containerRunId: next(2) === 0 ? 'g0' : 'g1',
          iteration: next(3),
          reviewIteration: next(8),
          rerunCause: next(2) === 0 ? 'review-reject' : 'review-iterate',
        }),
      )
    const sequenced = materializedSequences(rows)
    const identified = identify(sequenced, (row) => ({
      task: {
        id: 't',
        subject: 'workflow',
        engine: 'dag',
        definition: {
          nodes: [
            { id: 'loop', kind: 'wrapper-loop', nodeIds: ['review'] },
            { id: 'review', kind: 'review' },
          ],
        },
      },
      container:
        row.containerRunId === null
          ? undefined
          : { row: sequenced.find((entry) => entry.id === row.containerRunId)! },
    }))
    const selections = latestBySlot(identified)
    const oracle = createRunSelectionOracleSnapshot(sequenced)
    for (const { slot } of identified) {
      expect(selections.get(encodeCanonicalRunSlot(slot))).toBe(
        (await oracle.current('t', slot))?.id,
      )
      const history = identified
        .filter((entry) => encodeCanonicalRunSlot(entry.slot) === encodeCanonicalRunSlot(slot))
        .sort((a, b) => compareRunSequence(a.row, b.row))
      expect(
        (await oracle.slotHistory('t', slot, { excludeSuperseded: true })).map((row) => row.id),
      ).toEqual(
        history
          .filter(({ row }) => !isStructurallySuperseded(row, sequenced))
          .map(({ row }) => row.id),
      )
    }
    expect(
      ledger.sites.some(
        (entry) => entry.path.endsWith('/review.ts') && entry.whyFrameless.length > 0,
      ),
    ).toBe(true)
    const family: RunFamily = { kind: 'node', nodeId: 'review' }
    const union = identified
      .filter(({ slot }) => runSlotInFamily(slot, family))
      .sort((a, b) => compareRunSequence(a.row, b.row))
    expect(union.map(({ row }) => row.id)).toEqual(
      (await oracle.familyHistory('t', { nodeId: 'review' })).map((row) => row.id),
    )
    const familyCurrent = union.at(-1)!.row.id
    expect(
      [...selections.entries()]
        .filter(([key]) => key.includes('"review"'))
        .some(([, id]) => id !== familyCurrent),
    ).toBe(true)
  },
)

test('replacing a wrapper does not erase a reusable shard from the older generation', async () => {
  const rows = [
    oracleRow('g0', { nodeId: 'wrapper', seq: 1 }),
    oracleRow('s0', {
      nodeId: 'inner',
      seq: 2,
      parentNodeRunId: 'g0',
      containerRunId: 'g0',
      shardKey: '',
      shardValueHash: 'h',
      rerunCause: 'fanout-shard',
      mergeState: 'merged',
    }),
    oracleRow('a0', {
      nodeId: 'agg',
      seq: 3,
      parentNodeRunId: 'g0',
      containerRunId: 'g0',
      rerunCause: 'fanout-aggregator',
    }),
    oracleRow('g1', { nodeId: 'wrapper', seq: 4, status: 'pending', rerunCause: 'review-reject' }),
  ]
  const sequenced = materializedSequences(rows)
  const identified = identify(sequenced, seedFacts(sequenced, { dag: 't', host: 'h', dw: 'd' }))
  const selections = latestBySlot(identified)
  const oracle = createRunSelectionOracleSnapshot(sequenced)
  const shard: RunSlot = { kind: 'shard', nodeId: 'inner', iteration: 0, shardKey: '' }
  expect(selections.get(encodeCanonicalRunSlot(shard))).toBe('s0')
  expect((await oracle.current('t', shard))?.id).toBe('s0')
  expect((await oracle.current('t', shard))?.structurallySuperseded).toBe(true)
  expect((await oracle.slotHistory('t', shard, { excludeSuperseded: true })).length).toBe(0)
  const view = await oracle.shardSet('t', {
    wrapperRunId: 'g1',
    iteration: 0,
    shards: [{ nodeId: 'inner', shardKey: '', valueHash: 'h' }],
    aggregatorNodeId: 'agg',
  })
  expect(view.shards[0]!.reusable?.id).toBe('s0')
  expect(view.shards[0]!.replayable).toBe(true)
  expect(view.aggregator?.id).toBe('a0')
  expect(view.aggregatorReplayable).toBe(true)
})
