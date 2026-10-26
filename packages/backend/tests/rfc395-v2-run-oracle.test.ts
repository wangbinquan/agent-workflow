// Seed writer membership is independent of the migration's identity derivation and oracle labels.
import { expect, test } from 'bun:test'
import type { RunSlot } from '@/modules/task-execution/domain/runSelection/slots'
import {
  encodeCanonicalRunSlot,
  decodeCanonicalRunSlot,
} from '@/modules/task-execution/domain/runSelection/slotKey'
import { decodeSyntheticOwner } from '@/modules/task-execution/domain/runSelection/syntheticOwner'
import { createRunSelectionOracleSnapshot } from '@/modules/task-execution/infrastructure/migration/oracle/snapshot'
import { oracleRow } from '@/modules/task-execution/infrastructure/migration/run/source'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  seedFrozenSelectionFamilies,
  runSource,
  runValues,
  taskFacts,
  taskMounts,
  writeTask,
} from './helpers/rfc395V2/runFixtures'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'

function seedSlot(row: SourceRow): RunSlot {
  const v = row.values,
    nodeId = String(v.node_id),
    taskId = String(v.task_id)
  if (nodeId === 'wrapper')
    return {
      kind: 'container',
      nodeId,
      frame: { containerRunId: null, iteration: Number(v.iteration) },
    }
  if (nodeId === 'ordinary')
    return { kind: 'node', nodeId, frame: { containerRunId: null, iteration: Number(v.iteration) } }
  if (nodeId === 'inner' || nodeId === 'shared')
    return {
      kind: 'shard',
      nodeId,
      iteration: Number(v.iteration),
      shardKey: v.shard_key as string | null,
    }
  if (nodeId === 'agg') return { kind: 'aggregator', nodeId, iteration: Number(v.iteration) }
  if (taskId.endsWith('-host') && v.rerun_cause !== 'wg-gate')
    return { kind: 'workgroup-host', nodeId, shardKey: v.shard_key as string | null }
  const kind =
    nodeId === '__repo_prep__'
      ? 'repo-prep'
      : v.rerun_cause === 'commit-push-session'
        ? 'commit-session'
        : v.rerun_cause === 'commit-push'
          ? 'commit-push'
          : v.rerun_cause === 'merge-resolve'
            ? 'merge-resolve'
            : v.rerun_cause === 'dw-gate'
              ? 'dw-gate'
              : v.rerun_cause === 'wg-gate'
                ? 'wg-gate'
                : 'dw-orchestrator'
  return {
    kind: 'synthetic',
    syntheticKind: kind,
    discriminator: nodeId,
    owner:
      v.parent_node_run_id === null
        ? { kind: 'task', id: taskId }
        : { kind: 'attempt', id: String(v.parent_node_run_id) },
  }
}

describeV2Providers('RFC-395 V2-N terminal and active oracle equivalence', (h) => {
  for (const status of ['done', 'running'])
    for (const seed of [7, 395, 20261023])
      test(`${status} seed ${seed}: oracle selections preserve proved slots and preserve the registered host/gate family difference`, async () => {
        await h.install()
        const fixture = await seedFrozenSelectionFamilies(h, seed, status)
        const input = await h.input([fixture.contribution], {
          fixtures: { taskFacts: fixture.tasks, taskMounts: fixture.mounts },
        })
        try {
          const sink = new V2MemorySink()
          const summary = await runConversion(input, sink)
          const targetRuns = new Map(sink.rows('node_runs').map((row) => [String(row.id), row]))
          const sourceRuns = new Map(fixture.rows.map((row) => [String(row.values.id), row]))
          const expectedSlots = new Map<string, { taskId: string; slot: RunSlot }>()
          for (const source of fixture.rows) {
            const target = targetRuns.get(String(source.values.id))!
            const slot = seedSlot(source)
            const key = encodeCanonicalRunSlot(slot)
            expectedSlots.set(JSON.stringify([source.values.task_id, key]), {
              taskId: String(source.values.task_id),
              slot,
            })
            expect(target.slot_key).toBe(key)
            if (slot.kind === 'synthetic')
              expect(decodeSyntheticOwner(String(target.synthetic_owner))).toEqual(slot.owner)
            if (slot.kind === 'workgroup-host')
              expect(decodeSyntheticOwner(String(target.synthetic_owner))).toEqual({
                kind: 'task',
                id: String(source.values.task_id),
              })
          }
          expect(
            [...new Set([...expectedSlots.values()].map(({ slot }) => slot.kind))].sort(),
          ).toEqual(['aggregator', 'container', 'node', 'shard', 'synthetic', 'workgroup-host'])
          const backfilled = fixture.rows.map((row) => {
            const target = targetRuns.get(String(row.values.id))!
            return oracleRow(row, Number(target.seq), {
              runId: String(target.id),
              taskId: String(target.task_id),
              containerRunId: target.container_run_id as string | null,
              scopePath: String(target.scope_path),
              iteration: Number(target.iteration),
              quality: 'recorded',
            })
          })
          const oracle = createRunSelectionOracleSnapshot(backfilled)
          const selections = new Map(
            sink
              .rows('node_run_selections')
              .map((row) => [JSON.stringify([row.task_id, row.slot_key]), row]),
          )
          for (const [key, { taskId, slot }] of expectedSlots) {
            const legacy = await oracle.current(taskId, slot)
            expect(legacy).not.toBeNull()
            const requestedKey = encodeCanonicalRunSlot(slot)
            let selectedId = legacy!.id
            if (encodeCanonicalRunSlot(seedSlot(sourceRuns.get(legacy!.id)!)) !== requestedKey) {
              expect(slot.kind).toBe('workgroup-host')
              const family = await oracle.familyHistory(taskId, {
                nodeId: slot.kind === 'workgroup-host' ? slot.nodeId : '',
                shardKey: slot.kind === 'workgroup-host' ? slot.shardKey : null,
              })
              expect(family.at(-1)!.id).toBe(legacy!.id)
              const exact = family.filter(
                (row) => encodeCanonicalRunSlot(seedSlot(sourceRuns.get(row.id)!)) === requestedKey,
              )
              selectedId = exact.at(-1)!.id
            }
            const target = selections.get(key)!
            expect(target.selected_run_id).toBe(selectedId)
            expect(targetRuns.get(selectedId)!.slot_key).toBe(target.slot_key)
            expect(target.selected_at).toBe(
              backfilled.find((row) => row.id === selectedId)!.startedAt ?? 100,
            )
            expect(target.generation_seq).toBe(0)
          }
          expect(selections.size).toBe(expectedSlots.size)
          expect(
            [...targetRuns.values()].filter((row) => row.record_mode === 'history-only'),
          ).toEqual([])
          expect(summary.blocks).toEqual([])
          expect(summary.historyOnly).toEqual([])
          for (const iteration of [0, 1]) {
            const frame = await oracle.currentInFrame(fixture.dag, {
              containerRunId: null,
              iteration,
            })
            for (const [nodeId, selected] of frame)
              if (nodeId === 'ordinary' || nodeId === 'wrapper') {
                const slot: RunSlot = {
                  kind: nodeId === 'wrapper' ? 'container' : 'node',
                  nodeId,
                  frame: { containerRunId: null, iteration },
                }
                expect(
                  selections.get(JSON.stringify([fixture.dag, encodeCanonicalRunSlot(slot)]))!
                    .selected_run_id,
                ).toBe(selected.id)
              }
            for (const wrapperRunId of fixture.generations) {
              const view = await oracle.shardSet(fixture.dag, {
                wrapperRunId,
                iteration,
                shards: [
                  { nodeId: 'inner', shardKey: 'a', valueHash: 'hash-a' },
                  { nodeId: 'inner', shardKey: '', valueHash: 'hash-a' },
                  { nodeId: 'shared', shardKey: null, valueHash: 'hash-a' },
                ],
                aggregatorNodeId: 'agg',
              })
              for (const shard of view.shards)
                if (shard.current)
                  expect(
                    selections.get(
                      JSON.stringify([fixture.dag, encodeCanonicalRunSlot(shard.slot)]),
                    )!.selected_run_id,
                  ).toBe(shard.current.id)
              if (view.aggregator) {
                expect(
                  selections.get(
                    JSON.stringify([
                      fixture.dag,
                      encodeCanonicalRunSlot({ kind: 'aggregator', nodeId: 'agg', iteration }),
                    ]),
                  )!.selected_run_id,
                ).toBe(view.aggregator.id)
                expect(view.aggregatorNewerThanInputs).toBe(
                  view.participating.every((row) => Number(view.aggregator!.seq) > Number(row.seq)),
                )
              }
              expect(view.aggregatorInputs).toEqual([])
              expect(view.aggregatorInputEvidence).toBe('unrecorded')
            }
          }
          expect(
            sink.rows('node_run_inputs').filter((row) => row.input_kind === 'aggregator-shard'),
          ).toEqual([])
          expect(
            sink
              .rows('node_runs')
              .filter((row) => decodeCanonicalRunSlot(String(row.slot_key)).kind === 'aggregator')
              .every((row) => row.inputs_recorded === false),
          ).toBe(true)
          const prep = await oracle.current(fixture.dag, {
            kind: 'synthetic',
            syntheticKind: 'repo-prep',
            discriminator: '__repo_prep__',
            owner: { kind: 'task', id: fixture.dag },
          })
          expect(prep!.retryIndex).toBe(9)
          const bySeq = backfilled
            .filter((row) => row.nodeId === '__repo_prep__')
            .sort((a, b) => Number(a.seq) - Number(b.seq))
            .at(-1)!
          expect(bySeq.retryIndex).toBeLessThan(9)
          expect(prep!.id).not.toBe(bySeq.id)
        } finally {
          await input.source.close()
        }
      }, 180_000)
  for (const status of ['running', 'failed', 'canceled', 'done'])
    test(`${status}: the legacy host picker selecting a gate is approved #70 with separate exact slots`, async () => {
      await h.install()
      const task = taskFacts('task', status, {
        subjectKind: 'workgroup',
        engineKind: 'workgroup-turns',
      })
      await writeTask(h, task)
      await h.write('node_runs', [
        runValues('host', { node_id: '__wg_leader__', rerun_cause: 'wg-leader-round', seq: 1 }),
        runValues('gate', { node_id: '__wg_leader__', rerun_cause: 'wg-gate', seq: 2 }),
      ])
      await h.write('workgroup_assignments', [
        {
          id: 'assignment',
          task_id: 'task',
          source: 'system',
          title: 'host output',
          status: 'done',
          created_by_run_id: 'host',
          created_at: 100,
          updated_at: 100,
        },
      ])
      await h.write('workgroup_task_state', [
        { task_id: 'task', gate_status: 'approved', updated_at: 100 },
      ])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        expect(result.blocks).toEqual([])
        const host = sink.rows('node_runs').find((row) => row.id === 'host')!
        const gate = sink.rows('node_runs').find((row) => row.id === 'gate')!
        expect(decodeCanonicalRunSlot(String(host.slot_key)).kind).toBe('workgroup-host')
        expect(decodeCanonicalRunSlot(String(gate.slot_key))).toMatchObject({
          kind: 'synthetic',
          syntheticKind: 'wg-gate',
        })
        expect(host.record_mode).toBe('executable')
        expect(gate.record_mode).toBe('executable')
        expect(
          sink
            .rows('node_run_selections')
            .map((row) => row.selected_run_id)
            .sort(),
        ).toEqual(['gate', 'host'])
        expect(result.historyOnly).toEqual([])
      } finally {
        await input.source.close()
      }
    }, 180_000)
  for (const status of ['running', 'done'])
    test(`${status}: NULL-cause commit session has proved identity but oracle mismatch is surfaced`, async () => {
      await h.install()
      const task = taskFacts('task', status)
      await writeTask(h, task, { $schema_version: 7, nodes: [], edges: [], inputs: [] })
      await h.write('node_runs', [
        runValues('parent', { node_id: '__commit_push__', commit_push_json: '{}', seq: 1 }),
        runValues('session', {
          node_id: '__commit_push__',
          parent_node_run_id: 'parent',
          seq: 2,
          rerun_cause: null,
        }),
      ])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink()
        const summary = await runConversion(input, sink)
        expect(summary.blocks.some((block) => block.code === 'v2-run-selection-mismatch')).toBe(
          status === 'running',
        )
        if (status === 'running')
          expect(sink.rows('node_runs').filter((row) => row.id === 'session')).toEqual([])
        else {
          const session = sink.rows('node_runs').find((row) => row.id === 'session')!
          expect(decodeCanonicalRunSlot(String(session.slot_key))).toMatchObject({
            kind: 'synthetic',
            syntheticKind: 'commit-session',
          })
          expect(session.record_mode).toBe('history-only')
        }
      } finally {
        await input.source.close()
      }
    }, 180_000)
})

test('plan 6.12 aggregator replay criterion is newer-than-participating history, without back-derived input edges', async () => {
  const sources = [
    runSource('w0', { node_id: 'w', rerun_cause: 'wrapper-init', seq: 1 }),
    runSource('s-old', {
      node_id: 's',
      parent_node_run_id: 'w0',
      container_run_id: 'w0',
      shard_key: 'a',
      rerun_cause: 'fanout-shard',
      seq: 2,
    }),
    runSource('agg', {
      node_id: 'agg',
      parent_node_run_id: 'w0',
      container_run_id: 'w0',
      rerun_cause: 'fanout-aggregator',
      seq: 3,
    }),
    runSource('w1', { node_id: 'w', rerun_cause: 'wrapper-init', seq: 4 }),
    runSource('s-new', {
      node_id: 's',
      parent_node_run_id: 'w1',
      container_run_id: 'w1',
      shard_key: 'a',
      rerun_cause: 'fanout-shard',
      status: 'failed',
      seq: 5,
    }),
  ]
  const rows = sources.map((row) =>
    oracleRow(row, Number(row.values.seq), {
      runId: String(row.values.id),
      taskId: 'task',
      containerRunId: row.values.container_run_id as string | null,
      scopePath: '',
      iteration: 0,
      quality: 'recorded',
    }),
  )
  const view = await createRunSelectionOracleSnapshot(rows).shardSet('task', {
    wrapperRunId: 'w1',
    iteration: 0,
    shards: [{ nodeId: 's', shardKey: 'a', valueHash: null }],
    aggregatorNodeId: 'agg',
  })
  expect(view.shards[0]!.current!.id).toBe('s-new')
  expect(view.participating.map((row) => row.id)).toEqual(['s-old'])
  expect(view.aggregatorReplayable).toBe(true)
  expect(view.aggregatorInputs).toEqual([])
})

describeV2Providers('RFC-395 N-b shared row presence', (h) => {
  test('missing external prompt still creates its config presence row', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('missing-prompt', { seq: 1, prompt_path: 'missing/prompt.md' }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      content: {
        async stat() {
          return { state: 'absent', cause: 'missing-at-freeze', evidence: 'fixture:missing-prompt' }
        },
        async read() {
          throw new Error('must not read missing prompt')
        },
      },
    })
    try {
      const sink = new V2MemorySink()
      await runConversion(input, sink)
      expect(sink.rows('node_run_configs').map((row) => row.node_run_id)).toEqual([
        'missing-prompt',
      ])
      expect(JSON.parse(String(sink.rows('node_run_configs')[0]?.prompt_ref_json))).toMatchObject({
        kind: 'local-file',
        location: { codec: 'prompt', value: { promptText: null, promptPath: 'missing/prompt.md' } },
      })
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
