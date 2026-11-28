// RFC-626 F2 (design §3.3, §3.4 rows 16-17, §7 "封存与保留"; T0 blocks.md table 3 X9/X12/X13 and
// fk-probes.md §2.4 C/E): run data that used to stop the upgrade, converted by the real engine.
// - Generation 0 is no longer emitted by the run rule (the task rule emits it from the task row).
// - `v2-run-sequence`: the row-less forms record a kept decision with automatic resolution and
//   let the target derive the allocation high water from its rows. The global allocation base
//   past 2^53 does the same and no longer sets every run and allocation row aside (gate G2-4);
//   a task whose own new sequence would pass 2^53 still sets its runs aside.
// - Numbers past 2^53 set one run aside (`v2-run-row-unusable`) instead of aborting conversion.
// - An input whose producer is another node takes the missing-producer path instead of producing
//   a row the run-input probe rejects (both resolutions).
// - A prompt file the inventory cannot read is recorded as missing instead of aborting with
//   automatic resolution; operator resolution still aborts there, as before (gate G2-2).
// - End to end: one undecodable run sets its whole run group aside; an unfinished task is then
//   ended, and its task row and generation-0 row are still converted.
import { expect, test } from 'bun:test'
import { taskConversion, runConversion } from '@/modules/task-execution/composition/conversion'
import { conversion as repositoryUrls } from '@/modules/source-control/infrastructure/migration/repositoryUrlRule'
import { RUN_SEQUENCE_KEPT } from '@/modules/task-execution/infrastructure/migration/run/allocations'
import { RUN_ROW_UNUSABLE } from '@/modules/task-execution/infrastructure/migration/run/source'
import { ConversionContractError } from '@/platform/persistence/migration/conversion/blockCodes'
import { prepareConversion } from '@/platform/persistence/migration/conversion/engine'
import { columnLookup, idSetLookup } from '@/platform/persistence/migration/conversion/lookups'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type { ContentStat } from '@/platform/persistence/migration/conversion/content'
import type { ConversionResolution } from '@/platform/persistence/migration/conversion/types'
import type { SourcePreflight } from '@/platform/persistence/migration/sourceTypes'
import { describeV2Providers, type V2Harness } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runValues, taskFacts, writeTask, ordinaryDefinition } from './helpers/rfc395V2/runFixtures'
import { taskRow, writeTaskFixture } from './helpers/rfc395V2/taskFixtures'
import {
  convertRuns,
  decisionRecords,
  undecodableRunSource,
  unitDispositions,
  type RunConversionResult,
} from './helpers/rfc626RunConversion'

const HUGE = 9007199254740993n
/** A source allocation high water past the safe range: every sequence base overflows. */
const overflowing = (preflight: SourcePreflight): SourcePreflight => ({
  ...preflight,
  identityHighWater: [
    {
      name: 'node_run_seq_allocations_seq',
      table: 'node_run_seq_allocations',
      column: 'seq',
      value: String(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
      isCalled: true,
      increment: '1',
    },
  ],
})
const RANGE_ERROR = 'Error: v2-run-sequence-range'
const setAside = (result: RunConversionResult) => result.summary.resolutions?.setAside.rows ?? []
const evidenceText = (result: RunConversionResult, runId: string) =>
  Buffer.from(
    result.sink.rows('execution_legacy_evidence').find((row) => row.record_id === runId)!
      .content_inline_bytes as Uint8Array,
  ).toString()
const contentFailing = (error: () => Error) => ({
  async stat(): Promise<ContentStat> {
    throw error()
  },
  async read(): Promise<Uint8Array> {
    throw new Error('the run rule never reads prompt bytes')
  },
})

/** The task and run contributions as bootstrap wires them, with the lookups they share. */
async function convertTasksAndRuns(h: V2Harness, resolution?: ConversionResolution) {
  const contributions = [taskConversion, runConversion]
  const generic: ConversionContribution = {
    rules: [],
    validators: [],
    lookups: [
      idSetLookup('users', 'id'),
      columnLookup('workflows', ['id'], ['builtin']),
      columnLookup('node_runs', ['id'], ['continuation_slot_key']),
      ...repositoryUrls.lookups.filter(
        (lookup) =>
          !contributions.some((contribution) =>
            contribution.lookups.some(
              (other) => other.key.id === lookup.key.id && other.key.version === lookup.key.version,
            ),
          ),
      ),
    ],
  }
  const input = await h.input([...contributions, generic], {
    candidateBuild: 'rfc626-f2-tasks-and-runs',
    source: await undecodableRunSource(h, 'bad'),
    ...(resolution ? { resolution } : {}),
  })
  const sink = new V2MemorySink()
  try {
    const prepared = await prepareConversion(input)
    try {
      const summary = await prepared.run(sink)
      return { plan: prepared.plan, summary, sink }
    } finally {
      prepared.close()
    }
  } finally {
    await input.source.close()
  }
}

describeV2Providers('RFC-626 F2 run rows that used to stop the upgrade', (h) => {
  test('the run rule emits no generation-0 row in either resolution', async () => {
    await h.install()
    const tasks = [taskFacts('a-empty'), taskFacts('b-runs', 'running')]
    for (const task of tasks) await writeTask(h, task)
    await h.write('node_runs', [runValues('run', { task_id: 'b-runs' })])
    for (const resolution of [undefined, 'automatic'] as const) {
      const result = await convertRuns(h, { tasks, ...(resolution ? { resolution } : {}) })
      expect(result.summary.blocks).toEqual([])
      expect(result.sink.rows('task_execution_generations')).toEqual([])
      expect(
        result.plan.tables.find((table) => table.table === 'node_runs')!.targets,
      ).not.toContain('task_execution_generations')
      expect(result.sink.rows('node_runs').map((row) => row.id)).toEqual(['run'])
    }
  }, 180_000)

  // Gate G2-4: the allocation base is one global value. Its error used to block (automatic: set
  // aside) every run and allocation row of the source and end every unfinished task with runs.
  // With automatic resolution the base now falls back to the largest sequence of the rows
  // (`max-row`, design §3.4 row 16): the runs convert and the fallback is recorded as kept.
  test('sequence base overflow: operator blocks as before; automatic converts the runs and records the fallback', async () => {
    await h.install()
    const tasks = [taskFacts('empty'), taskFacts('runs')]
    for (const task of tasks) await writeTask(h, task)
    await h.write('node_runs', [
      runValues('a', { task_id: 'runs', seq: 1 }),
      runValues('b', { task_id: 'runs', seq: 2 }),
    ])

    const manual = await convertRuns(h, { tasks, preflight: overflowing })
    expect(manual.summary.blocks).toContainEqual({
      code: 'v2-run-sequence',
      scope: 'global',
      sourceTable: null,
      sourceKey: null,
      taskId: 'empty',
      runId: null,
      missingFields: ['seq'],
      detail: { error: RANGE_ERROR },
    })
    expect(manual.summary.blocks).toContainEqual({
      code: 'v2-run-sequence',
      scope: 'global',
      sourceTable: 'node_run_seq_allocations',
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: ['seq'],
      detail: { error: RANGE_ERROR },
    })
    expect(
      manual.summary.blocks
        .filter((block) => block.scope === 'row')
        .map((block) => [block.code, block.runId])
        .sort(),
    ).toEqual([
      ['v2-run-sequence', 'a'],
      ['v2-run-sequence', 'b'],
    ])
    expect(decisionRecords(manual.sink, RUN_SEQUENCE_KEPT)).toEqual([])

    const automatic = await convertRuns(h, {
      tasks,
      preflight: overflowing,
      resolution: 'automatic',
    })
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.plan.settlements).toEqual([])
    // Neither task is given a new sequence, so only the allocation rule records the fallback.
    const kept = decisionRecords(automatic.sink, RUN_SEQUENCE_KEPT)
    expect(kept.map((record) => record.payload)).toEqual([
      expect.objectContaining({
        automatic: 'kept',
        sourceTable: 'node_run_seq_allocations',
        taskId: null,
        error: RANGE_ERROR,
        identityHighWater: 'max-row',
      }),
    ])
    expect(automatic.summary.resolutions!.kept.byCode[RUN_SEQUENCE_KEPT]).toBe(1)
    // No allocation high water is recorded: the target derives it from its largest row.
    expect(
      automatic.summary.records.filter(
        (record) =>
          record.kind === 'identity-high-water' && record.table === 'node_run_seq_allocations',
      ),
    ).toEqual([])
    // The runs convert with the sequences they had; nothing is set aside.
    expect(
      automatic.sink
        .rows('node_runs')
        .map((row) => [row.id, row.seq])
        .sort(),
    ).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect(setAside(automatic).filter((row) => row.sourceTable === 'node_runs')).toEqual([])
  }, 180_000)

  test('sequence base overflow on an unfinished task: the task is not ended and its runs convert', async () => {
    await h.install()
    const task = taskFacts('live', 'running')
    await writeTask(h, task)
    await h.write('node_runs', [runValues('r', { task_id: 'live' })])
    const automatic = await convertRuns(h, {
      tasks: [task],
      preflight: overflowing,
      resolution: 'automatic',
    })
    expect(automatic.plan.settlements).toEqual([])
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.sink.rows('node_runs').map((row) => row.id)).toEqual(['r'])
  }, 180_000)

  // Gate G2-4, from the rows themselves: an allocation high water next to 2^53 and two runs
  // still to be given a sequence. The second one (b2) cannot be given a safe one, so its task
  // keeps the row-level `v2-run-sequence`; every other run converts.
  test('allocation high water next to 2^53: only the task whose new sequence would pass it loses its runs', async () => {
    await h.install()
    const tasks = [taskFacts('a-task'), taskFacts('b-task'), taskFacts('c-task', 'running')]
    for (const task of tasks) await writeTask(h, task)
    await h.write('node_runs', [
      runValues('a1', { task_id: 'a-task', seq: 1 }),
      runValues('a2', { task_id: 'a-task', seq: null, retry_index: 1 }),
      runValues('b1', { task_id: 'b-task', seq: 2 }),
      runValues('b2', { task_id: 'b-task', seq: null, retry_index: 1 }),
      runValues('c1', { task_id: 'c-task', seq: 3, status: 'running' }),
    ])
    const highWater = Number.MAX_SAFE_INTEGER - 1
    await h.write('node_run_seq_allocations', [
      { seq: highWater, task_id: 'gone-task', node_run_id: 'gone-run', allocated_at: 1 },
    ])

    const manual = await convertRuns(h, { tasks })
    const rowBlocks = (table: string) =>
      manual.summary.blocks
        .filter((block) => block.scope === 'row' && block.sourceTable === table)
        .map((block) => block.code)
    expect(rowBlocks('node_runs')).toEqual(Array(5).fill('v2-run-sequence'))
    expect(rowBlocks('node_run_seq_allocations')).toEqual(['v2-run-sequence'])

    const automatic = await convertRuns(h, { tasks, resolution: 'automatic' })
    expect(automatic.summary.blocks).toEqual([])
    // c-task could continue; the base no longer makes its run unprovable.
    expect(automatic.plan.settlements).toEqual([])
    expect(
      automatic.sink
        .rows('node_runs')
        .map((row) => [row.id, row.seq])
        .sort(),
    ).toEqual([
      ['a1', 1],
      ['a2', Number.MAX_SAFE_INTEGER],
      ['c1', 3],
    ])
    expect(automatic.sink.rows('node_run_seq_allocations')).toMatchObject([
      { seq: Number.MAX_SAFE_INTEGER, task_id: 'a-task', node_run_id: 'a2' },
    ])
    expect(
      setAside(automatic)
        .filter((row) => row.sourceTable === 'node_runs')
        .map((row) => row.code),
    ).toEqual(['v2-run-sequence', 'v2-run-sequence'])
    // The allocation of a deleted task keeps its own path; it is not set aside.
    expect(
      unitDispositions(automatic.sink).find(
        (row) => row.sourceTable === 'node_run_seq_allocations',
      ),
    ).toMatchObject({ class: 'archived', decision: { code: 'v2-run-deleted-task-allocation' } })
    expect(
      setAside(automatic).filter((row) => row.sourceTable === 'node_run_seq_allocations'),
    ).toEqual([])
    expect(
      decisionRecords(automatic.sink, RUN_SEQUENCE_KEPT)
        .map((record) => record.payload)
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ).toEqual([
      expect.objectContaining({ sourceTable: 'node_run_seq_allocations', taskId: null }),
      expect.objectContaining({ sourceTable: 'node_runs', taskId: 'a-task' }),
    ])
    expect(
      automatic.summary.records.filter(
        (record) =>
          record.kind === 'identity-high-water' && record.table === 'node_run_seq_allocations',
      ),
    ).toEqual([])
  }, 180_000)

  for (const column of [
    'seq',
    'iteration',
    'retry_index',
    'review_iteration',
    'wg_round',
    'started_at',
  ])
    test(`${column} past 2^53 sets that run aside; the task's other runs convert`, async () => {
      await h.install()
      const task = taskFacts('task', 'done')
      await writeTask(h, task)
      await h.write('node_runs', [
        runValues('good', { seq: 1 }),
        runValues('huge', { seq: 2, [column]: HUGE }),
      ])

      const manual = await convertRuns(h, { tasks: [task] })
      expect(manual.summary.blocks).toMatchObject([
        {
          code: RUN_ROW_UNUSABLE,
          scope: 'row',
          sourceTable: 'node_runs',
          taskId: 'task',
          runId: 'huge',
          missingFields: [column],
          detail: { unusable: [{ column, value: String(HUGE) }] },
        },
      ])
      expect(manual.sink.rows('node_runs').map((row) => row.id)).toEqual(['good'])

      const automatic = await convertRuns(h, { tasks: [task], resolution: 'automatic' })
      expect(automatic.summary.blocks).toEqual([])
      expect(automatic.plan.settlements).toEqual([])
      expect(setAside(automatic)).toMatchObject([
        { sourceTable: 'node_runs', code: RUN_ROW_UNUSABLE },
      ])
      expect(
        unitDispositions(automatic.sink).find(
          (row) => row.sourceTable === 'node_runs' && row.class === 'archived',
        ),
      ).toMatchObject({ kind: 'archived', decision: { code: RUN_ROW_UNUSABLE } })
      expect(automatic.sink.rows('node_runs')).toMatchObject([
        { id: 'good', record_mode: 'executable' },
      ])
    }, 180_000)

  test('a run past 2^53 in an unfinished task ends the task; its other runs convert', async () => {
    await h.install()
    const task = taskFacts('task', 'interrupted')
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('good', { seq: 1 }),
      runValues('huge', { seq: 2, iteration: HUGE }),
    ])
    const automatic = await convertRuns(h, { tasks: [task], resolution: 'automatic' })
    expect(automatic.plan.settlements).toMatchObject([
      { taskId: 'task', originalStatus: 'interrupted', blockCodes: [RUN_ROW_UNUSABLE] },
    ])
    expect(automatic.summary.blocks).toEqual([])
    expect(automatic.calls).toEqual([])
    expect(automatic.sink.rows('node_runs')).toMatchObject([{ id: 'good' }])
  }, 180_000)

  const inputSnapshot = {
    $schema_version: 7,
    inputs: [],
    nodes: [
      { id: 'a', kind: 'script' },
      { id: 'b', kind: 'script' },
      { id: 'c', kind: 'script' },
    ],
    edges: [],
  }
  test('an input naming another node than its producer keeps no reference, in both resolutions', async () => {
    const snapshot = inputSnapshot
    await h.install()
    const task = taskFacts('task', 'done')
    await writeTask(h, task, snapshot)
    await h.write('node_runs', [
      runValues('p', { node_id: 'a', seq: 1 }),
      runValues('ok', { node_id: 'b', seq: 2, consumed_upstream_runs_json: '{"a":"p"}' }),
      runValues('bad', { node_id: 'c', seq: 3, consumed_upstream_runs_json: '{"b":"p"}' }),
    ])
    const inputs = (result: RunConversionResult) =>
      [...result.sink.rows('node_run_inputs')].sort((a, b) =>
        String(a.consumer_run_id).localeCompare(String(b.consumer_run_id)),
      )
    const manual = await convertRuns(h, { tasks: [task] })
    const automatic = await convertRuns(h, { tasks: [task], resolution: 'automatic' })
    for (const result of [manual, automatic]) {
      expect(result.summary.blocks).toEqual([])
      const [bad, ok] = inputs(result)
      expect(ok).toMatchObject({
        consumer_run_id: 'ok',
        producer_run_ref: 'p',
        evidence_ref_json: null,
      })
      expect(bad).toMatchObject({
        consumer_run_id: 'bad',
        producer_run_id: 'p',
        producer_run_ref: null,
        producer_node_id: 'b',
        provenance_quality: 'legacy-derived',
      })
      expect(JSON.parse(String(bad!.evidence_ref_json))).toEqual({
        code: 'v2-run-input-producer-missing',
        producerRunId: 'p',
        producerNodeId: 'b',
        recordedNodeId: 'a',
      })
      expect(
        result.summary.historyOnly.find((row) => row.history?.runId === 'bad')!.decision,
      ).toMatchObject({ code: 'v2-run-history-only' })
    }
    expect(inputs(automatic)).toEqual(inputs(manual))
  }, 180_000)

  test('an input naming another node than its producer blocks an unfinished task, or ends it', async () => {
    await h.install()
    const running = taskFacts('task', 'running')
    await writeTask(h, running, inputSnapshot)
    await h.write('node_runs', [
      runValues('p', { node_id: 'a', seq: 1 }),
      runValues('bad', { node_id: 'c', seq: 2, consumed_upstream_runs_json: '{"b":"p"}' }),
    ])
    const blocked = await convertRuns(h, { tasks: [running] })
    expect(
      blocked.summary.blocks.some(
        (block) => block.code === 'v2-run-input-producer-missing' && block.runId === 'bad',
      ),
    ).toBe(true)
    const ended = await convertRuns(h, { tasks: [running], resolution: 'automatic' })
    expect(ended.plan.settlements![0]!.blockCodes).toContain('v2-run-input-producer-missing')
    expect(ended.summary.blocks).toEqual([])
  }, 180_000)

  for (const [name, error, cause] of [
    ['unlisted', () => new Error('content-unlisted-present'), 'originally-absent'],
    [
      'unreadable',
      () => Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
      'missing-at-freeze',
    ],
  ] as const)
    test(`a ${name} prompt file is recorded as missing with automatic resolution; operator still aborts`, async () => {
      await h.install()
      const task = taskFacts('task', 'done')
      await writeTask(h, task)
      await h.write('node_runs', [runValues('file', { prompt_path: 'task/prompts/file.md' })])
      const result = await convertRuns(h, {
        tasks: [task],
        content: contentFailing(error),
        resolution: 'automatic',
      })
      expect(result.summary.blocks).toEqual([])
      expect(result.summary.historyOnly).toEqual([])
      const receipts = [...result.sink.units.values()].flatMap((unit) => unit.artifacts)
      expect(receipts).toHaveLength(1)
      expect(receipts[0]).toMatchObject({
        sourceColumn: 'prompt_path',
        originalReference: 'task/prompts/file.md',
        bytes: null,
        missing: { state: cause },
      })
      expect(result.sink.rows('node_runs')).toMatchObject([
        { id: 'file', record_mode: 'executable' },
      ])
      expect(result.sink.rows('node_run_configs')[0]!.prompt_ref_json).not.toBeNull()
      expect(evidenceText(result, 'file')).toContain('v2-run-prompt-missing')
      // Gate G2-2: the manual flow (no resolution, or `operator`) keeps the behavior it had
      // before RFC-626 — the conversion ends with the inventory's error, the plan reports it.
      const thrown = error().message
      for (const resolution of [undefined, 'operator'] as const)
        await expect(
          convertRuns(h, {
            tasks: [task],
            content: contentFailing(error),
            ...(resolution ? { resolution } : {}),
          }),
        ).rejects.toThrow(thrown)
    }, 180_000)

  test('an engine contract error from the inventory still ends the conversion', async () => {
    await h.install()
    const task = taskFacts('task', 'done')
    await writeTask(h, task)
    await h.write('node_runs', [runValues('file', { prompt_path: 'task/prompts/file.md' })])
    for (const resolution of [undefined, 'automatic'] as const)
      await expect(
        convertRuns(h, {
          tasks: [task],
          content: contentFailing(
            () => new ConversionContractError('v2-fixture-contract', 'engine fault'),
          ),
          ...(resolution ? { resolution } : {}),
        }),
      ).rejects.toThrow('v2-fixture-contract')
  }, 180_000)

  for (const status of ['running', 'done'])
    test(`${status}: one undecodable run sets the whole run group aside; the task row and generation 0 remain`, async () => {
      await h.install()
      await writeTaskFixture(
        h,
        taskRow('e2e', { status, workflow_snapshot: JSON.stringify(ordinaryDefinition) }),
      )
      await h.write('node_runs', [
        runValues('good', { task_id: 'e2e', seq: 1 }),
        runValues('bad', { task_id: 'e2e', seq: 2 }),
      ])

      const automatic = await convertTasksAndRuns(h, 'automatic')
      expect(automatic.summary.blocks).toEqual([])
      if (status === 'running') {
        expect(automatic.plan.settlements).toMatchObject([
          {
            taskId: 'e2e',
            cause: 'unprovable-records',
            originalStatus: 'running',
            parentTaskId: null,
          },
        ])
        expect(automatic.plan.settlements![0]!.blockCodes).toContain('v2-source-codec')
      } else expect(automatic.plan.settlements).toEqual([])
      expect(automatic.sink.rows('node_runs')).toEqual([])
      expect(
        (automatic.summary.resolutions?.setAside.rows ?? [])
          .filter((row) => row.sourceTable === 'node_runs')
          .map((row) => row.code)
          .sort(),
      ).toEqual(['v2-group-member-blocked', 'v2-source-codec'])
      expect(
        unitDispositions(automatic.sink).filter(
          (row) => row.sourceTable === 'node_runs' && row.class === 'archived',
        ),
      ).toHaveLength(2)
      expect(automatic.sink.rows('tasks').find((row) => row.id === 'e2e')).toMatchObject({
        status: status === 'running' ? 'canceled' : 'done',
      })
      expect(automatic.sink.rows('task_execution_generations')).toEqual([
        {
          task_id: 'e2e',
          generation_seq: 0,
          cause: 'legacy-epoch1',
          previous_generation_seq: null,
          operation_ref: null,
          created_at: 1001,
        },
      ])

      if (status !== 'running') return
      const manual = await convertTasksAndRuns(h)
      expect(manual.plan.settlements).toBeUndefined()
      expect(
        manual.summary.blocks
          .filter((block) => block.sourceTable === 'node_runs')
          .map((block) => [block.code, block.runId])
          .sort(),
      ).toEqual([
        ['v2-group-member-blocked', 'good'],
        ['v2-source-codec', 'bad'],
      ])
    }, 180_000)
})
