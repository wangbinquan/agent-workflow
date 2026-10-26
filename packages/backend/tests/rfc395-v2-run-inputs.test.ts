import { expect, test } from 'bun:test'
import { convertConsumedInputs } from '@/modules/task-execution/infrastructure/migration/run/inputs'
import { conversion } from '@/modules/task-execution/infrastructure/migration/run'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import {
  runSource,
  runValues,
  taskFacts,
  taskMounts,
  writeTask,
} from './helpers/rfc395V2/runFixtures'

test('D16 NULL is unrecorded, {} is recorded without edges, malformed JSON is an explicit fresh decision', () => {
  const convert = (raw: string | null) =>
    convertConsumedInputs(runSource('c', { consumed_upstream_runs_json: raw }), new Map())
  expect(convert(null)).toEqual({ inputs: [], recorded: false, decisions: [] })
  expect(convert('{}')).toEqual({ inputs: [], recorded: true, decisions: [] })
  for (const raw of ['', '{bad', '[]', 'null']) {
    expect(convert(raw).recorded).toBe(false)
    expect(convert(raw).decisions[0]!.code).toBe('v2-run-inputs-malformed')
  }
})
test('D16 raw text ordering survives integer-like keys, escaped keys, and nested invalid values', () => {
  const producers = new Map([
    ['p', runSource('p', { shard_key: '' })],
    ['q', runSource('q', { shard_key: null })],
  ])
  const converted = convertConsumedInputs(
    runSource('c', {
      consumed_upstream_runs_json: '{"10":"p","2":"q","a\\u003ab":"p","invalid":{"x":[1,2]}}',
    }),
    producers,
  )
  expect(
    converted.inputs.map((row) => [row.ordinal, row.producer_node_id, row.producer_shard_slot]),
  ).toEqual([
    [0, '10', 'shard-v1:key:""'],
    [1, '2', 'shard-v1:none'],
    [2, 'a:b', 'shard-v1:key:""'],
  ])
  expect(converted.decisions.map((decision) => decision.code)).toEqual(['v2-run-inputs-non-string'])
})
test('missing or other-task producers retain original id and evidence, never acquire a fabricated FK', () => {
  const converted = convertConsumedInputs(
    runSource('c', { consumed_upstream_runs_json: '{"n":"missing","other":"p"}' }),
    new Map([['p', runSource('p', { task_id: 'elsewhere' })]]),
  )
  expect(converted.inputs.map((row) => row.producer_run_ref)).toEqual([null, null])
  expect(converted.inputs.map((row) => row.producer_run_id)).toEqual(['missing', 'p'])
  expect(
    converted.inputs.every(
      (row) => row.provenance_quality === 'legacy-derived' && row.evidence_ref_json !== null,
    ),
  ).toBe(true)
})
test('duplicate source keys keep JSON last-value semantics and exact text ordinal with evidence', () => {
  const converted = convertConsumedInputs(
    runSource('c', { consumed_upstream_runs_json: '{"n":"old","z":"p","n":"p"}' }),
    new Map([['p', runSource('p')]]),
  )
  expect(
    converted.inputs.map((row) => [row.producer_node_id, row.ordinal, row.producer_run_id]),
  ).toEqual([
    ['z', 1, 'p'],
    ['n', 2, 'p'],
  ])
  expect(converted.decisions[0]!.code).toBe('v2-run-inputs-duplicate-key')
})

describeV2Providers('RFC-395 V2-N consumed inputs', (h) => {
  test('D2 conversion only writes recorded frame-input edges; source JSON text order is retained', async () => {
    await h.install()
    const task = taskFacts()
    await writeTask(h, task)
    await h.write('node_runs', [
      runValues('p', { seq: 1 }),
      runValues('c', { seq: 2, consumed_upstream_runs_json: '{ "10": "p", "2": "p" }' }),
    ])
    const input = await h.input([conversion], {
      fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      expect(
        sink
          .rows('node_run_inputs')
          .map((row) => [row.ordinal, row.producer_node_id, row.input_kind]),
      ).toEqual([
        [0, '10', 'frame-input'],
        [1, '2', 'frame-input'],
      ])
      expect(sink.rows('node_runs').find((row) => row.id === 'p')!.inputs_recorded).toBe(false)
      expect(sink.rows('node_runs').find((row) => row.id === 'c')!.inputs_recorded).toBe(true)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  for (const status of ['running', 'failed', 'canceled', 'done'])
    test(`D16 ${status}: malformed consumed JSON preserves fresh behavior and its original evidence`, async () => {
      await h.install()
      const task = taskFacts('task', status)
      await writeTask(h, task)
      await h.write('node_runs', [runValues('c', { consumed_upstream_runs_json: '{bad' })])
      const input = await h.input([conversion], {
        fixtures: { taskFacts: [task], taskMounts: [taskMounts()] },
      })
      try {
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        // CORE-1 must deliver the taken-over row to sequence/frame lookups too.
        expect(result.blocks).toEqual([])
        expect(result.historyOnly).toEqual([])
        expect(
          [...sink.units.values()]
            .flatMap((unit) => unit.dispositions)
            .find((row) => row.decision?.code === 'v2-run-codec-takeover')!.codecColumns,
        ).toEqual(['consumed_upstream_runs_json'])
        expect(sink.rows('node_runs')[0]).toMatchObject({
          id: 'c',
          inputs_recorded: false,
          record_mode: 'executable',
        })
        expect(sink.rows('node_run_inputs')).toEqual([])
        const evidence = sink.rows('execution_legacy_evidence')[0]!
        const original = Buffer.from(evidence.content_inline_bytes as Uint8Array).toString()
        expect(original).toContain('v2-run-inputs-malformed')
        expect(original).toContain('{bad')
      } finally {
        await input.source.close()
      }
    }, 180_000)
})
