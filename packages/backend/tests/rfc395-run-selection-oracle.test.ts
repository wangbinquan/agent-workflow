// RFC-395 II-a A3：用 A1 fixture 和双 provider 将六个端口方法与旧 picker、wrapper 和 SQL 孪生逐项对拍。
import { expect, test } from 'bun:test'
import { compareNodeRunMintOrder } from './helpers/model/frozenSelection/order'
import type { NodeRunStatus } from '@agent-workflow/shared'
import { isMergeStateSettled } from './helpers/model/frozenSelection/fanout'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  pickLatestRunInFrame,
  pickFrameSourceRun,
  pickLatestSettledRun,
  pickFreshestRun,
  pickReusableShardRun,
  parseConsumedJson,
} from './helpers/model/frozenSelection/pickers'
import { isStructurallySuperseded } from './helpers/model/frozenSelection/supersession'
import { frozenS6, frozenS7 } from './helpers/model/frozenSelection/epoch1RepositoryPreparation'
import type {
  RunSlot,
  SelectionChange,
  WrapperSlotRef,
} from '@/modules/task-execution/application/ports/runSelection'
import { createRunSelectionReader } from '@/modules/task-execution/infrastructure/migration/oracle/reader'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import { createRunSelectionParticipantInTx } from '@/modules/task-execution/infrastructure/migration/oracle/participant'
import { FROZEN_MIGRATIONS } from './migration-freeze'
import type { OracleRunRow } from '@/modules/task-execution/infrastructure/migration/oracle/rows'
import { describeEachProvider } from './helpers/eachProvider'
import {
  nodeRunFixture,
  patchNodeRunFixture,
  readNodeRunFixtures,
  taskFixture,
  workflowFixture,
  type NodeRunFixtureSpec,
} from './helpers/model/frozenSelection/storage'
import {
  patchLegacyRunSelectionFixture,
  readRunSelectionOracleFixtures,
  readUnsupersededRunSelectionFixtureIds,
  readRunSelectionTimelineFixtureIds,
} from './helpers/model/frozenSelection/storage'

function random(seed: number) {
  let value = seed >>> 0
  return (max: number) => {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0
    return value % max
  }
}

async function seedHistory(db: PersistenceDb, seed: number) {
  const taskId = `selection-task-${seed}`
  const workflowId = `selection-workflow-${seed}`
  const id = (name: string) => `${taskId}-${name}`
  const definition = { $schema_version: 2, inputs: [], nodes: [], edges: [] }
  await workflowFixture(db, { id: workflowId, name: workflowId, definition })
  for (const suffix of ['', '-child-a', '-child-b'])
    await taskFixture(db, {
      id: taskId + suffix,
      workflowId,
      workflowSnapshot: definition,
      repoPath: '/nonexistent/rfc395-selection',
      worktreePath: '/nonexistent/rfc395-selection',
      baseBranch: 'main',
      branch: `test/${taskId}${suffix}`,
      status: 'running',
      inputs: {},
      startedAt: 0,
    })
  let index = 0
  const add = async (name: string, nodeId: string, options: Partial<NodeRunFixtureSpec> = {}) => {
    const seq = index < 4 ? -100 + index : index + 1
    index += 1
    await nodeRunFixture(db, { id: id(name), taskId, nodeId, status: 'done', seq, ...options })
  }
  await add('w0', 'wrapper', { rerunCause: 'wrapper-init', status: 'failed' })
  await add('nested', 'nested-wrapper', {
    rerunCause: 'wrapper-init',
    containerRunId: id('w0'),
    iteration: 1,
  })
  await add('legacy-a', 'legacy')
  await add('legacy-z', 'legacy')
  await patchLegacyRunSelectionFixture(db, id('legacy-a'), { seq: null })
  await patchLegacyRunSelectionFixture(db, id('legacy-z'), { seq: null })
  await add('ordinary-old', 'ordinary', { retryIndex: 40, startedAt: 900 })
  await add('ordinary-new', 'ordinary', { retryIndex: 0, startedAt: 1 })
  await add('timeline-null', 'timeline', { startedAt: null })
  await add('timeline-negative', 'timeline', { startedAt: -1 })
  await add('timeline-zero', 'timeline', { startedAt: 0 })
  await add('s-a', 'inner', {
    parentNodeRunId: id('w0'),
    containerRunId: id('w0'),
    shardKey: 'a',
    shardValueHash: null,
    rerunCause: 'fanout-shard',
    mergeState: 'merged',
  })
  await add('s-b', 'inner', {
    parentNodeRunId: id('w0'),
    containerRunId: id('w0'),
    shardKey: 'b',
    shardValueHash: 'hash-b',
    rerunCause: 'fanout-shard',
  })
  await add('broadcast', 'shared', {
    parentNodeRunId: id('w0'),
    containerRunId: id('w0'),
    rerunCause: 'fanout-shard',
  })
  await add('agg', 'agg', {
    parentNodeRunId: id('w0'),
    containerRunId: id('w0'),
    rerunCause: 'fanout-aggregator',
  })
  await add('w1', 'wrapper', { rerunCause: 'wrapper-init', status: 'interrupted' })
  await add('s-b-new', 'inner', {
    parentNodeRunId: id('w1'),
    containerRunId: id('w1'),
    shardKey: 'b',
    shardValueHash: 'different',
    status: 'interrupted',
    rerunCause: 'process-retry',
  })
  await add('review', 'review', {
    status: 'awaiting_review',
    reviewIteration: 2,
    consumedEdges: [{ producerNodeId: 'ordinary', producerRunId: id('ordinary-new') }],
  })
  await add('clarify-old', 'clarify', { status: 'done', rerunCause: 'clarify-answer' })
  await add('clarify-new', 'clarify', {
    status: 'pending',
    rerunCause: 'cross-clarify-answer',
    retryIndex: 1,
  })
  await add('call-a', 'call', {
    childTaskId: taskId + '-child-a',
    startedAt: 900,
    containerRunId: id('nested'),
    iteration: 1,
  })
  await add('call-b', 'call', {
    childTaskId: taskId + '-child-b',
    startedAt: 100,
    containerRunId: id('nested'),
    iteration: 1,
  })
  await add('prep-old', '__repo_prep__', { retryIndex: 9 })
  await add('prep-new', '__repo_prep__', { retryIndex: 1 })
  await add('commit', '__commit_push__:ordinary', {
    rerunCause: 'commit-push',
    parentNodeRunId: id('ordinary-new'),
  })
  await add('commit-session', '__commit_push__:ordinary', {
    rerunCause: 'commit-push-session',
    parentNodeRunId: id('commit'),
  })
  await add('merge', '__merge_resolve__:ordinary', {
    rerunCause: 'merge-resolve',
    parentNodeRunId: id('ordinary-new'),
  })
  await add('dw', '__dw_orchestrator__', { rerunCause: 'dw-generate' })
  await add('dw-gate', '__dw_orchestrator__', { rerunCause: 'dw-gate', status: 'awaiting_review' })
  await add('wg0', '__wg_member__', {
    shardKey: 'assignment',
    wgRound: 1,
    rerunCause: 'wg-assignment',
  })
  await add('wg1', '__wg_member__', {
    shardKey: 'assignment',
    wgRound: 2,
    retryIndex: 1,
    rerunCause: 'wg-protocol-retry',
    status: 'running',
  })
  await add('wg-message', '__wg_member__', {
    shardKey: 'msg:1',
    wgRound: null,
    rerunCause: 'wg-message-turn',
  })
  await add('wg-gate', '__wg_leader__', { rerunCause: 'wg-gate', status: 'awaiting_review' })
  await add('memory-frame0', 'random-review', {
    containerRunId: id('w0'),
    iteration: 1,
    shardKey: 'a',
    reviewIteration: 2,
  })
  await add('memory-frame1', 'random-review', {
    containerRunId: id('w1'),
    iteration: 1,
    shardKey: 'a',
    reviewIteration: 2,
  })
  const next = random(seed)
  const statuses: readonly NodeRunStatus[] = [
    'pending',
    'done',
    'failed',
    'skipped',
    'interrupted',
    'awaiting_review',
    'awaiting_human',
    'canceled',
  ]
  for (let i = 0; i < 36; i += 1) {
    const containerRunId = [null, id('w0'), id('w1'), id('nested')][next(4)]!
    const child = next(3) === 0
    await add(`random-${(i * 17) % 37}`, ['random-a', 'random-b', 'random-review'][next(3)]!, {
      status: statuses[next(statuses.length)]!,
      iteration: next(3),
      containerRunId,
      parentNodeRunId: child ? (containerRunId ?? id('w0')) : null,
      shardKey: [null, '', 'a', 'b'][next(4)]!,
      retryIndex: next(5),
      reviewIteration: next(3),
      startedAt: next(3) === 0 ? null : next(5),
      mergeState: ['merged', 'pending-merge', 'isolating', null][next(4)]!,
      rerunCause: child ? 'fanout-shard' : 'revival',
      ...(next(2) === 0
        ? { consumedEdges: [{ producerNodeId: 'ordinary', producerRunId: id('ordinary-old') }] }
        : {}),
    })
  }
  return { taskId, id, rows: await readRunSelectionOracleFixtures(db, taskId) }
}

const ids = (rows: readonly { id: string }[]) => rows.map((row) => row.id)

describeEachProvider(
  'RFC-395 frozen epoch-1 selection oracle',
  (harness) => {
    test.each([1, 395, 2026])(
      'seed %i: every slot / frame / history / consumed equals the old readers',
      async (seed) => {
        const { db } = harness
        const { taskId, id, rows } = await seedHistory(db, seed)
        const reader = createRunSelectionReader(db)
        const memory = createRunSelectionOracleSnapshot([...rows].reverse())
        const nodes = [...new Set(rows.map((row) => row.nodeId))]
        for (const containerRunId of [null, id('w0'), id('w1'), id('nested')])
          for (const iteration of [0, 1, 2]) {
            const frame = { containerRunId, iteration }
            const expected = new Map<string, string>()
            for (const nodeId of nodes) {
              const slot: RunSlot = { kind: 'node', nodeId, frame }
              const candidates = rows.filter((row) => row.nodeId === nodeId)
              const old = pickLatestRunInFrame(candidates, frame)
              if (old !== undefined) expected.set(nodeId, old.id)
              expect((await reader.current(taskId, slot))?.id ?? null).toBe(old?.id ?? null)
              expect((await memory.current(taskId, slot))?.id ?? null).toBe(old?.id ?? null)
              const history = candidates
                .filter(
                  (row) =>
                    row.parentNodeRunId === null &&
                    row.containerRunId === containerRunId &&
                    row.iteration === iteration,
                )
                .sort(compareNodeRunMintOrder)
              expect(ids(await reader.slotHistory(taskId, slot))).toEqual(ids(history))
              expect(
                (await reader.slotHistory(taskId, slot, { statusIn: ['done', 'skipped'] })).at(-1)
                  ?.id,
              ).toBe(pickFrameSourceRun(candidates, frame)?.id)
            }
            const actual = await reader.currentInFrame(taskId, frame)
            expect(await memory.currentInFrame(taskId, frame)).toEqual(actual)
            const orderedNodes = [
              ...new Set(
                rows
                  .filter(
                    (row) =>
                      row.parentNodeRunId === null &&
                      row.containerRunId === containerRunId &&
                      row.iteration === iteration,
                  )
                  .sort(compareNodeRunMintOrder)
                  .map((row) => row.nodeId),
              ),
            ]
            expect([...actual.keys()]).toEqual(orderedNodes)
            expect([...actual].map(([nodeId, run]) => [nodeId, run.id]).sort()).toEqual(
              [...expected].sort(),
            )
          }
        const cases: {
          slot: RunSlot
          candidates: readonly OracleRunRow[]
          retryFirst?: boolean
        }[] = [
          {
            slot: {
              kind: 'container',
              nodeId: 'wrapper',
              frame: { containerRunId: null, iteration: 0 },
            },
            candidates: rows.filter((row) => row.nodeId === 'wrapper'),
          },
          {
            slot: { kind: 'shard', nodeId: 'inner', iteration: 0, shardKey: 'a' },
            candidates: rows.filter(
              (row) =>
                row.nodeId === 'inner' &&
                row.parentNodeRunId !== null &&
                row.iteration === 0 &&
                row.shardKey === 'a',
            ),
          },
          {
            slot: { kind: 'shard', nodeId: 'shared', iteration: 0, shardKey: null },
            candidates: rows.filter(
              (row) => row.nodeId === 'shared' && row.parentNodeRunId !== null,
            ),
          },
          {
            slot: { kind: 'aggregator', nodeId: 'agg', iteration: 0 },
            candidates: rows.filter(
              (row) =>
                row.nodeId === 'agg' && row.parentNodeRunId !== null && row.shardKey === null,
            ),
          },
          {
            slot: {
              kind: 'synthetic',
              owner: { kind: 'task', id: taskId },
              syntheticKind: 'repo-prep',
              discriminator: '__repo_prep__',
            },
            candidates: rows.filter((row) => row.nodeId === '__repo_prep__'),
            retryFirst: true,
          },
          {
            slot: { kind: 'workgroup-host', nodeId: '__wg_member__', shardKey: 'assignment' },
            candidates: rows.filter(
              (row) => row.nodeId === '__wg_member__' && row.shardKey === 'assignment',
            ),
          },
        ]
        for (const [name, syntheticKind, nodeId, ownerId] of [
          ['commit', 'commit-push', '__commit_push__:ordinary', id('ordinary-new')],
          ['commit-session', 'commit-session', '__commit_push__:ordinary', id('commit')],
          ['merge', 'merge-resolve', '__merge_resolve__:ordinary', id('ordinary-new')],
          ['dw', 'dw-orchestrator', '__dw_orchestrator__', null],
          ['dw-gate', 'dw-gate', '__dw_orchestrator__', null],
          ['wg-gate', 'wg-gate', '__wg_leader__', null],
        ] as const)
          cases.push({
            slot: {
              kind: 'synthetic',
              owner:
                ownerId === null ? { kind: 'task', id: taskId } : { kind: 'attempt', id: ownerId },
              syntheticKind,
              discriminator: nodeId,
            },
            candidates: rows.filter((row) => row.id === id(name)),
          })
        for (const { slot, candidates, retryFirst } of cases) {
          const chronological = [...candidates].sort(compareNodeRunMintOrder)
          const old = retryFirst
            ? await frozenS6({ deps: { db } }, taskId)
            : pickFreshestRun(candidates, { topLevelOnly: false })
          const selected = await reader.current(taskId, slot)
          expect(selected?.id).toBe(old?.id)
          if (retryFirst) expect(selected?.id).toBe((await frozenS7({ db }, taskId))?.id)
          expect(await memory.current(taskId, slot)).toEqual(selected)
          expect(selected).not.toHaveProperty('consumedUpstreamRunsJson')
          expect(selected).not.toHaveProperty('promptText')
          expect(ids(await reader.slotHistory(taskId, slot))).toEqual(ids(chronological))
          expect(ids(await memory.slotHistory(taskId, slot))).toEqual(ids(chronological))
        }
        for (const nodeId of nodes) {
          const candidates = rows.filter((row) => row.nodeId === nodeId)
          expect(ids(await reader.familyHistory(taskId, { nodeId }))).toEqual(
            ids([...candidates].sort(compareNodeRunMintOrder)),
          )
          expect(
            (
              await reader.familyHistory(
                taskId,
                { nodeId },
                { topLevelOnly: true, statusIn: ['done', 'skipped'] },
              )
            ).at(-1)?.id,
          ).toBe(pickLatestSettledRun(candidates)?.id)
        }
        for (const row of rows) {
          const old = Object.entries(parseConsumedJson(row.consumedUpstreamRunsJson)).map(
            ([producerNodeId, producerRunId]) => ({ producerNodeId, producerRunId }),
          )
          expect(await reader.consumed(row.id)).toEqual(old)
          expect(await memory.consumed(row.id)).toEqual(old)
        }
        expect(await reader.consumed('missing')).toEqual([])
        expect(await reader.current('missing-task', cases[0]!.slot)).toBeNull()
        const superseded = await reader.familyHistory(taskId, {}, { excludeSuperseded: true })
        expect(ids(superseded).sort()).toEqual([
          ...(await readUnsupersededRunSelectionFixtureIds(db, taskId)),
        ])
        expect(ids(superseded).sort()).toEqual(
          ids(rows.filter((row) => !isStructurallySuperseded(row, rows))).sort(),
        )
        expect(superseded.length).toBeLessThan(rows.length)
        expect(superseded.length).toBeGreaterThan(0)
      },
      60_000,
    )

    test('fanout cross-generation reuse / hash NULL match / in-place retries / aggregation preserve all old branches', async () => {
      const { taskId, id, rows } = await seedHistory(harness.db, 31)
      const reader = createRunSelectionReader(harness.db)
      const requests: WrapperSlotRef['shards'] = [
        { nodeId: 'inner', shardKey: 'a', valueHash: 'anything' },
        { nodeId: 'inner', shardKey: 'b', valueHash: 'hash-b' },
        { nodeId: 'shared', shardKey: null, valueHash: null },
        { nodeId: 'inner', shardKey: 'missing', valueHash: null },
      ]
      for (const flags of [{}, { reuseDisabled: true }, { processRetryIndex: 0 }]) {
        const wrapper: WrapperSlotRef = {
          wrapperRunId: id('w1'),
          iteration: 0,
          shards: requests,
          aggregatorNodeId: 'agg',
          ...flags,
        }
        const view = await reader.shardSet(taskId, wrapper)
        expect(await createRunSelectionOracleSnapshot(rows).shardSet(taskId, wrapper)).toEqual(view)
        const participating: OracleRunRow[] = []
        for (let i = 0; i < requests.length; i += 1) {
          const request = requests[i]!
          const candidates = rows.filter(
            (row) =>
              row.nodeId === request.nodeId &&
              row.iteration === 0 &&
              row.parentNodeRunId !== null &&
              row.shardKey === request.shardKey,
          )
          const freshest = pickFreshestRun(candidates, { topLevelOnly: false })
          const input = pickReusableShardRun(candidates, request)
          if (input !== undefined) participating.push(input)
          const reusable =
            flags.reuseDisabled || flags.processRetryIndex !== undefined ? undefined : input
          expect(view.shards[i]?.current?.id).toBe(freshest?.id)
          expect(view.shards[i]?.reusable?.id).toBe(reusable?.id)
          expect(view.shards[i]?.replayable).toBe(
            reusable !== undefined &&
              reusable.id === freshest?.id &&
              (isMergeStateSettled(reusable.mergeState) ||
                reusable.mergeState === 'conflict-human'),
          )
          expect(view.shards[i]?.rerunInPlace).toBe(
            flags.processRetryIndex === undefined &&
              freshest !== undefined &&
              freshest.status !== 'done' &&
              freshest.parentNodeRunId === id('w1'),
          )
        }
        expect(ids(view.participating)).toEqual(ids(participating))
        const aggregator = pickFreshestRun(
          rows.filter(
            (row) => row.nodeId === 'agg' && row.parentNodeRunId !== null && row.shardKey === null,
          ),
          { topLevelOnly: false },
        )!
        expect(view.aggregator?.id).toBe(aggregator.id)
        expect(view.aggregatorNewerThanInputs).toBe(
          participating.every((row) => compareNodeRunMintOrder(aggregator, row) > 0),
        )
        expect(view.aggregatorReplayable).toBe(
          !flags.reuseDisabled &&
            flags.processRetryIndex === undefined &&
            aggregator.status === 'done' &&
            participating.every((row) => compareNodeRunMintOrder(aggregator, row) > 0) &&
            (isMergeStateSettled(aggregator.mergeState) ||
              aggregator.mergeState === 'conflict-human'),
        )
        expect(view.aggregatorInputs).toEqual([])
        expect(view.aggregatorInputEvidence).toBe('unrecorded')
      }
      const reused = await reader.shardSet(taskId, {
        wrapperRunId: id('w1'),
        iteration: 0,
        shards: requests,
      })
      expect(reused.shards[0]?.current?.parentNodeRunId).toBe(id('w0'))
      expect(reused.shards[0]?.replayable).toBe(true)
      expect(reused.shards[0]?.singleMergedCandidate?.id).toBe(id('s-a'))
      expect(reused.shards[1]?.replayable).toBe(false)
      expect(reused.shards[1]?.rerunInPlace).toBe(true)
      await patchNodeRunFixture(
        harness.db,
        { id: id('s-b-new') },
        { status: 'done', shardValueHash: 'hash-b' },
      )
      const rerun = await reader.shardSet(taskId, {
        wrapperRunId: id('w1'),
        iteration: 0,
        shards: requests,
        aggregatorNodeId: 'agg',
      })
      expect(rerun.shards[1]?.current?.id).toBe(id('s-b-new'))
      expect(rerun.aggregatorNewerThanInputs).toBe(false)
    })

    test('wrapper resumability, review reset and mint-order call adoption match HEAD', async () => {
      const { taskId, id, rows } = await seedHistory(harness.db, 41)
      const reader = createRunSelectionReader(harness.db)
      const wrapperSlot: RunSlot = {
        kind: 'container',
        nodeId: 'wrapper',
        frame: { containerRunId: null, iteration: 0 },
      }
      // Historical selection evidence. The live resumability path is locked by
      // rfc395-selection-table-equivalence.test.ts: activated wrapper resumability.
      const wrapper = {
        async findResumable(input: {
          taskId: string
          nodeId: string
          containerRunId: string | null
          iteration: number
        }) {
          const stored = await readRunSelectionOracleFixtures(harness.db, input.taskId)
          const latest = pickLatestRunInFrame(
            stored.filter((row) => row.nodeId === input.nodeId),
            input,
          )
          return latest && !['done', 'failed', 'exhausted'].includes(latest.status) ? latest : null
        },
      }
      const old = await wrapper.findResumable({
        taskId,
        nodeId: 'wrapper',
        containerRunId: null,
        iteration: 0,
      })
      expect((await reader.current(taskId, wrapperSlot))?.id).toBe(old?.id)
      expect((await reader.current(taskId, wrapperSlot))?.resumable).toBe(true)
      await patchNodeRunFixture(harness.db, { id: id('w1') }, { status: 'done' })
      expect(
        await wrapper.findResumable({
          taskId,
          nodeId: 'wrapper',
          containerRunId: null,
          iteration: 0,
        }),
      ).toBeNull()
      expect((await reader.current(taskId, wrapperSlot))?.resumable).toBe(false)
      const reviewSlot: RunSlot = {
        kind: 'node',
        nodeId: 'review',
        frame: { containerRunId: null, iteration: 0 },
      }
      const before = await reader.current(taskId, reviewSlot)
      await patchNodeRunFixture(
        harness.db,
        { id: id('review') },
        { reviewIteration: 3, status: 'pending' },
      )
      const after = await reader.current(taskId, reviewSlot)
      expect(after?.slot).toEqual(before?.slot)
      expect(after?.id).toBe(before?.id)
      expect(after?.reviewIteration).toBe(3)
      const callSlot: RunSlot = {
        kind: 'node',
        nodeId: 'call',
        frame: { containerRunId: id('nested'), iteration: 1 },
      }
      for (const name of ['call-a', 'call-b'])
        await patchNodeRunFixture(harness.db, { id: id(name) }, { status: 'interrupted' })
      const oldAdoption = pickLatestRunInFrame(
        rows.filter((row) => row.nodeId === 'call'),
        callSlot.frame,
      )
      const adoption = await reader.current(taskId, callSlot)
      expect(adoption?.id).toBe(oldAdoption?.id)
      expect(adoption?.childTaskId).toBe(taskId + '-child-b')
      expect(adoption?.status).toBe('interrupted')
      await patchNodeRunFixture(harness.db, { id: id('call-b') }, { status: 'canceled' })
      await nodeRunFixture(harness.db, {
        id: id('call-placeholder'),
        // RFC-395 II-a: this history seeds explicit seq values, bypassing the allocator.
        // Make the later placeholder newer in HEAD's mint order as well.
        seq: Math.max(...rows.map((row) => row.seq ?? 0)) + 1,
        taskId,
        nodeId: 'call',
        status: 'pending',
        containerRunId: id('nested'),
        iteration: 1,
        rerunCause: 'retry-node',
      })
      const latest = await reader.current(taskId, callSlot)
      const adopted =
        latest !== null &&
        latest.childTaskId !== null &&
        ['pending', 'running', 'interrupted', 'canceled'].includes(latest.status)
          ? latest
          : null
      expect(latest?.id).toBe(id('call-placeholder'))
      expect(adopted).toBeNull()
    })

    test('family filters preserve frame-blind review/memory/workgroup histories and explicit legacy rankings', async () => {
      const { taskId, rows } = await seedHistory(harness.db, 68)
      const reader = createRunSelectionReader(harness.db)
      expect(ids(await reader.familyHistory(taskId, {}, { order: 'api-timeline' }))).toEqual(
        await readRunSelectionTimelineFixtureIds(harness.db, taskId),
      )
      const timeline = await reader.familyHistory(
        taskId,
        { nodeId: 'timeline' },
        { order: 'api-timeline' },
      )
      const callOrder = await reader.familyHistory(
        taskId,
        { nodeId: 'timeline' },
        { order: 'started-at' },
      )
      expect(timeline[0]?.startedAt).toBeNull()
      expect(callOrder[0]?.startedAt).toBe(-1)
      const family = { nodeId: 'random-review', iteration: 1, shardKey: 'a', reviewIteration: 2 }
      const expected = rows
        .filter(
          (row) =>
            row.nodeId === family.nodeId &&
            row.iteration === family.iteration &&
            row.shardKey === family.shardKey &&
            row.reviewIteration === family.reviewIteration &&
            row.parentNodeRunId === null,
        )
        .sort(compareNodeRunMintOrder)
      expect(expected.length).toBeGreaterThanOrEqual(2)
      expect(ids(await reader.familyHistory(taskId, family, { topLevelOnly: true }))).toEqual(
        ids(expected),
      )
      for (const order of ['retry-index', 'iteration', 'running-first'] as const) {
        const priority = (row: OracleRunRow) =>
          order === 'retry-index'
            ? row.retryIndex
            : order === 'iteration'
              ? row.iteration
              : Number(row.status === 'running')
        const old = [...rows].sort(
          (a, b) => priority(b) - priority(a) || compareNodeRunMintOrder(b, a),
        )
        expect(ids(await reader.familyHistory(taskId, {}, { order, direction: 'desc' }))).toEqual(
          ids(old),
        )
      }
      const anchor = { id: 'deleted-anchor', seq: null }
      expect(ids(await reader.familyHistory(taskId, {}, { after: anchor }))).toEqual(
        ids(
          rows
            .filter((row) => compareNodeRunMintOrder(row, anchor) > 0)
            .sort(compareNodeRunMintOrder),
        ),
      )
      const host = rows
        .filter((row) => row.nodeId === '__wg_member__' && row.wgRound === 2)
        .sort(compareNodeRunMintOrder)
      expect(
        ids(await reader.familyHistory(taskId, { nodeId: '__wg_member__', wgRound: 2 })),
      ).toEqual(ids(host))
    })

    test('consumed retains old malformed / source-node behavior, including aggregator source maps', async () => {
      const { taskId, id } = await seedHistory(harness.db, 58)
      const reader = createRunSelectionReader(harness.db)
      for (const json of [
        null,
        '',
        'bad',
        '[]',
        'null',
        '3',
        '{"a":"run-a","b":3,"c":null}',
        '{"x":"r1","x":"r2"}',
      ]) {
        await patchLegacyRunSelectionFixture(harness.db, id('agg'), {
          consumedUpstreamRunsJson: json,
        })
        const old = Object.entries(parseConsumedJson(json)).map(
          ([producerNodeId, producerRunId]) => ({ producerNodeId, producerRunId }),
        )
        expect(await reader.consumed(id('agg'))).toEqual(old)
        expect(
          (
            await reader.shardSet(taskId, {
              wrapperRunId: id('w1'),
              iteration: 0,
              shards: [],
              aggregatorNodeId: 'agg',
            })
          ).aggregatorInputs,
        ).toEqual(old)
      }
    })

    test('II-a apply adds no SQL in an owner transaction and leaves persisted bytes unchanged', async () => {
      const { taskId, id } = await seedHistory(harness.db, 3)
      const reader = createRunSelectionReader(harness.db)
      const run = (await reader.current(taskId, {
        kind: 'node',
        nodeId: 'ordinary',
        frame: { containerRunId: null, iteration: 0 },
      }))!
      const change: SelectionChange = {
        kind: 'select',
        taskId,
        slot: run.slot,
        run,
        expectedRevision: 0,
        generationSeq: 0,
        cause: 'initial',
      }
      const before = await readNodeRunFixtures(harness.db, { taskId })
      await harness.session.transaction(async (tx) => {
        const recording = harness.recordStatements()
        try {
          expect(
            (await createRunSelectionParticipantInTx<typeof tx>().apply(tx, [change]))[0]
              ?.selectedRunId,
          ).toBe(id('ordinary-new'))
          expect(recording.statements).toEqual([])
        } finally {
          recording.stop()
        }
      })
      expect(await readNodeRunFixtures(harness.db, { taskId })).toEqual(before)
    })
  },
  { sqliteMigrationsFolder: FROZEN_MIGRATIONS },
)
