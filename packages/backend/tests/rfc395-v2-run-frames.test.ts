// O2 port: generation reconstruction and the lookup handed to V2-C, without startup wiring.
import { expect, test } from 'bun:test'
import {
  backfillLegacyFrames,
  type FrameRow,
} from '@/modules/task-execution/infrastructure/migration/run/frames'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { frozenRunDefinition } from '@/modules/task-execution/infrastructure/migration/run/definitions'
import { RUN_FRAMES } from '@/platform/persistence/migration/conversion/lookups/keys'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runValues, taskFacts, taskMounts, writeTask } from './helpers/rfc395V2/runFixtures'

function row(id: string, nodeId: string, over: Partial<FrameRow> = {}): FrameRow {
  return {
    id,
    nodeId,
    seq: null,
    iteration: 0,
    parentNodeRunId: null,
    containerRunId: null,
    scopePath: '',
    ...over,
  }
}
const parentOf = new Map([
  ['inner', 'outer'],
  ['body', 'inner'],
  ['shard', 'fanout'],
])
test('O2 1: nested loops attach to the latest earlier generation', () => {
  expect(
    backfillLegacyFrames({
      parentOf,
      rows: [
        row('01', 'outer'),
        row('02', 'inner'),
        row('03', 'body'),
        row('04', 'body', { iteration: 1 }),
        row('05', 'inner', { iteration: 1 }),
        row('00', 'root'),
      ],
    }),
  ).toEqual({
    unresolved: [],
    updates: [
      { id: '02', containerRunId: '01', scopePath: 'outer:0' },
      { id: '03', containerRunId: '02', scopePath: 'outer:0/inner:0' },
      { id: '04', containerRunId: '02', scopePath: 'outer:0/inner:1' },
      { id: '05', containerRunId: '01', scopePath: 'outer:1' },
    ],
  })
})
test('O2 2: fanout children use their wrapper; nested sessions inherit the parent frame; top sessions stay top', () => {
  expect(
    backfillLegacyFrames({
      parentOf,
      rows: [
        row('01', 'fanout', { iteration: 2 }),
        row('02', 'shard', { parentNodeRunId: '01', iteration: 2 }),
        row('03', 'outer'),
        row('04', 'inner'),
        row('05', 'body'),
        row('06', 'session', { parentNodeRunId: '05' }),
        row('07', 'root'),
        row('08', 'session', { parentNodeRunId: '07' }),
      ],
    }).updates,
  ).toEqual([
    { id: '02', containerRunId: '01', scopePath: 'fanout:2' },
    { id: '04', containerRunId: '03', scopePath: 'outer:0' },
    { id: '05', containerRunId: '04', scopePath: 'outer:0/inner:0' },
    { id: '06', containerRunId: '04', scopePath: 'outer:0/inner:0' },
  ])
})
test('O2 3: recorded frames are preserved, serve as generations, and the second plan has zero updates', () => {
  const rows = [
    row('01', 'outer'),
    row('02', 'inner', { containerRunId: '01', scopePath: 'outer:0' }),
    row('03', 'body', { containerRunId: '02', scopePath: 'outer:0/inner:0' }),
    row('04', 'body', { iteration: 1 }),
  ]
  const plan = backfillLegacyFrames({ parentOf, rows })
  expect(plan.updates).toEqual([{ id: '04', containerRunId: '02', scopePath: 'outer:0/inner:1' }])
  expect(
    backfillLegacyFrames({
      parentOf,
      rows: rows.map((entry) => ({
        ...entry,
        ...plan.updates.find((update) => update.id === entry.id),
      })),
    }),
  ).toEqual({ updates: [], unresolved: [] })
})
test('O2 4: no earlier generation is unresolved, never attached to a later wrapper', () => {
  expect(
    backfillLegacyFrames({
      parentOf,
      rows: [row('01', 'body'), row('02', 'inner'), row('03', 'outer')],
    }),
  ).toEqual({ updates: [], unresolved: ['01', '02'] })
})
test('O2 10 and 11: seq=2/id=a body attaches to seq=1/id=z wrapper with wrapper:0', () => {
  expect(
    backfillLegacyFrames({
      parentOf: new Map([['body', 'wrapper']]),
      rows: [row('a', 'body', { seq: 2 }), row('z', 'wrapper', { seq: 1 })],
    }).updates,
  ).toEqual([{ id: 'a', containerRunId: 'z', scopePath: 'wrapper:0' }])
})
test('O2 6: malformed or invalid-scope frozen definitions stay unreadable', () => {
  for (const raw of [
    '{bad',
    '',
    JSON.stringify({
      $schema_version: 7,
      nodes: [{ id: 'x', kind: 'wrapper-loop', nodeIds: ['x'] }],
      edges: [],
    }),
  ])
    expect(frozenRunDefinition(raw).readable).toBe(false)
})

// Test consumers exercise the inter-package contract, never another package's conversion code.
const receiptConsumers: ConversionContribution = {
  lookups: [],
  validators: [],
  rules: [
    {
      ref: { id: 'fixture/run-task-receipt', version: 1 },
      owner: 'fixture',
      claims: ['tasks'],
      produces: [],
      lookups: [],
      unit: { kind: 'source-chunk', table: 'tasks' },
      convert(unit, ctx) {
        for (const row of unit.rows.get('tasks')!)
          ctx.out.record(
            { kind: 'decision', code: 'fixture-task', payload: String(row.values.id) },
            row,
          )
      },
    },
    {
      ref: { id: 'fixture/clarify-frame-consumer', version: 1 },
      owner: 'fixture',
      claims: ['clarify_rounds'],
      produces: [],
      lookups: [RUN_FRAMES],
      unit: { kind: 'source-chunk', table: 'clarify_rounds' },
      convert(unit, ctx) {
        for (const row of unit.rows.get('clarify_rounds')!) {
          const frame = ctx.lookup(RUN_FRAMES).require(String(row.values.intermediary_node_run_id))
          ctx.out.record(
            {
              kind: 'decision',
              code: 'fixture-clarify-alignment',
              payload: {
                roundId: String(row.values.id),
                containerRunId: frame.containerRunId,
                iteration: frame.iteration,
                changed: row.values.container_run_id !== frame.containerRunId,
              },
            },
            row,
          )
        }
      },
    },
  ],
}
const snapshot = {
  $schema_version: 7,
  inputs: [],
  nodes: [
    { id: 'outer', kind: 'wrapper-loop', nodeIds: ['inner'] },
    { id: 'inner', kind: 'wrapper-loop', nodeIds: ['body'] },
    { id: 'body', kind: 'clarify' },
  ],
  edges: [],
}

describeV2Providers('RFC-395 V2-N O2 frame handoff', (h) => {
  test('O2 9: already aligned round records zero further alignments and an empty task still gets a generation', async () => {
    await h.install()
    const tasks = [taskFacts('task'), taskFacts('empty')]
    for (const task of tasks) await writeTask(h, task, snapshot)
    await h.write('node_runs', [
      runValues('w', { node_id: 'outer', rerun_cause: 'wrapper-init', seq: 1 }),
      runValues('i', {
        node_id: 'inner',
        rerun_cause: 'wrapper-init',
        seq: 2,
        container_run_id: 'w',
        scope_path: 'outer:0',
      }),
      runValues('b', {
        node_id: 'body',
        seq: 3,
        container_run_id: 'i',
        scope_path: 'outer:0/inner:0',
      }),
    ])
    await h.write('clarify_rounds', [
      {
        id: 'round',
        task_id: 'task',
        kind: 'self',
        asking_node_id: 'body',
        asking_node_run_id: 'b',
        intermediary_node_id: 'body',
        intermediary_node_run_id: 'b',
        container_run_id: 'i',
        questions_json: '[]',
        status: 'answered',
        created_at: 100,
      },
    ])
    const input = await h.input([conversion, receiptConsumers], {
      fixtures: { taskFacts: tasks, taskMounts: tasks.map((task) => taskMounts(task.taskId)) },
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(sink.rows('task_execution_generations')).toHaveLength(2)
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.records)
          .find(
            (record) => record.kind === 'decision' && record.code === 'fixture-clarify-alignment',
          ),
      ).toMatchObject({ payload: { changed: false } })
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('O2 5/8/9: one task, four frame updates, one round; exact receipts and identical replay digest', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task, snapshot)
    await h.write('node_runs', [
      runValues('01', { node_id: 'outer', seq: null, rerun_cause: 'wrapper-init' }),
      runValues('02', { node_id: 'inner', seq: null, rerun_cause: 'wrapper-init' }),
      runValues('03', { node_id: 'body', seq: null }),
      runValues('04', { node_id: 'body', iteration: 1, seq: null }),
      runValues('05', { node_id: 'inner', iteration: 1, seq: null, rerun_cause: 'wrapper-init' }),
    ])
    await h.write('clarify_rounds', [
      {
        id: 'round',
        task_id: 'task',
        kind: 'self',
        asking_node_id: 'body',
        asking_node_run_id: '03',
        intermediary_node_id: 'body',
        intermediary_node_run_id: '03',
        questions_json: '[]',
        status: 'answered',
        created_at: 100,
      },
    ])
    const input = await h.input([conversion, receiptConsumers], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.blocks).toEqual([])
      expect(
        sink
          .rows('node_runs')
          .map((run) => [run.id, run.container_run_id, run.scope_path])
          .sort(([a], [b]) => String(a).localeCompare(String(b))),
      ).toEqual([
        ['01', null, ''],
        ['02', '01', 'outer:0'],
        ['03', '02', 'outer:0/inner:0'],
        ['04', '02', 'outer:0/inner:1'],
        ['05', '01', 'outer:1'],
      ])
      const alignments = [...sink.units.values()]
        .flatMap((unit) => unit.records)
        .filter(
          (record) => record.kind === 'decision' && record.code === 'fixture-clarify-alignment',
        )
      expect(alignments).toEqual([
        {
          kind: 'decision',
          code: 'fixture-clarify-alignment',
          payload: { roundId: 'round', containerRunId: '02', iteration: 0, changed: true },
        },
      ])
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'tasks')!.rowsRead,
      ).toBe(1)
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'node_runs')!.rowsRead,
      ).toBe(5)
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'clarify_rounds')!.rowsRead,
      ).toBe(1)
      expect(sink.rows('node_runs').filter((run) => run.container_run_id !== null)).toHaveLength(4)
      const digests = [...sink.units.values()].map((unit) => unit.receipt.digest)
      await runConversion(input, sink)
      expect([...sink.units.values()].map((unit) => unit.receipt.digest)).toEqual(digests)
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.records)
          .filter(
            (record) => record.kind === 'decision' && record.code === 'fixture-clarify-alignment',
          ),
      ).toHaveLength(1)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('O2 7: a changed preflight source refuses conversion before any unit commits', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      await h.write('node_runs', [runValues('late')])
      const sink = new V2MemorySink()
      await expect(runConversion(input, sink)).rejects.toThrow()
      expect(sink.units.size).toBe(0)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  for (const status of ['running', 'failed', 'canceled', 'done'])
    test(`O2 4/6: unparseable snapshot is untouched and classified for ${status}`, async () => {
      await h.install()
      const task = taskFacts('task', status)
      await writeTask(h, task, '{bad')
      await h.write('node_runs', [runValues('run')])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink()
        const summary = await runConversion(input, sink)
        if (status === 'running') expect(sink.rows('node_runs')).toEqual([])
        else
          expect(sink.rows('node_runs')[0]).toMatchObject({
            container_run_id: null,
            scope_path: '',
            record_mode: 'history-only',
          })
        expect(summary.blocks.some((block) => block.code === 'v2-run-frame-unresolved')).toBe(
          status === 'running',
        )
        expect(
          [...sink.units.values()]
            .flatMap((unit) => unit.dispositions)
            .filter((row) => row.kind === 'history-only'),
        ).toHaveLength(status === 'running' ? 0 : 1)
      } finally {
        await input.source.close()
      }
    }, 180_000)
})
