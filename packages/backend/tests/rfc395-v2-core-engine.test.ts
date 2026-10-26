// RFC-395 V2-core A: real frozen sources, injected rules; no stage-B/domain implementation.
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { explainSourceRow } from '@/platform/persistence/migration/conversion/trace'
import { planConversion } from '@/platform/persistence/migration/conversion/plan'
import {
  columnLookup,
  idSetLookup,
  lookupKey,
} from '@/platform/persistence/migration/conversion/lookups'
import {
  TASK_FACTS,
  TASK_MOUNTS,
  RUN_FRAMES,
  type TaskFacts,
} from '@/platform/persistence/migration/conversion/lookups/keys'
import { rowBlock } from '@/platform/persistence/migration/conversion/blockCodes'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import { encodeMigrationKey } from '@/platform/persistence/migration/conversion/migrationKey'
import { valueDigest } from '@/platform/persistence/migration/conversion/digest'
import { encodeStagedValue } from '@/platform/persistence/migration/conversion/staging'
import type {
  ConversionContribution,
  ConversionRule,
} from '@/platform/persistence/migration/conversion/rule'
import type { ExceptionKind } from '@/platform/persistence/migration/conversion/types'

function copyRule(table: string): ConversionRule {
  return {
    ref: { id: `fixture/${table}`, version: 1 },
    owner: 'fixture',
    claims: [table],
    produces: [{ table }],
    lookups: [],
    unit: { kind: 'source-chunk', table },
    disposition: 'preserved',
    convert(unit, ctx) {
      for (const row of unit.rows.get(table)!) ctx.out.row(table, row.values, row)
    },
  }
}
function contribution(rule: ConversionRule): ConversionContribution {
  return { rules: [rule], lookups: [], validators: [] }
}
function taskFacts(taskId: string): TaskFacts {
  return {
    taskId,
    parentTaskId: null,
    rootTaskId: null,
    status: 'done',
    startedAt: 123,
    execution: 'terminal-history',
    subjectKind: 'workflow',
    sourceId: null,
    definitionAnchorId: 'definition',
    engineKind: 'dag',
    spaceKind: 'internal',
    workflowVersion: 1,
  }
}

describeV2Providers('RFC-395 V2 engine', (h) => {
  test('stages all non-aligned reads before dependency-ordered lookups and emits conserved receipts', async () => {
    await h.install()
    await h.write(
      'maintenance_state',
      ['e', 'a', 'd', 'b', 'c'].map((key, index) => ({
        key,
        value: `{ "index": ${index} }`,
        updated_at: index,
      })),
    )
    const events: string[] = []
    const base = copyRule('maintenance_state')
    const ids = idSetLookup('maintenance_state', 'key')
    const columns = columnLookup('maintenance_state', ['key'], ['value'])
    const derived = lookupKey<string>('fixture/derived', 1)
    const rules: ConversionContribution = {
      rules: [
        {
          ...base,
          lookups: [derived],
          convert(unit, ctx) {
            events.push('convert')
            expect(ctx.lookup(derived).require('complete')).toBe('5')
            base.convert(unit, ctx)
          },
        },
      ],
      validators: [],
      lookups: [
        {
          key: derived,
          sources: ['maintenance_state'],
          dependsOn: [ids.key, columns.key],
          build(staged, put, lookups) {
            events.push('lookup')
            expect(staged.count('maintenance_state')).toBe(5)
            expect(lookups(ids.key).require('a')).toBe(true)
            expect(lookups(columns.key).require('a').value).toBe('{ "index": 1 }')
            put('complete', String(staged.count('maintenance_state')))
          },
        },
        columns,
        ids,
      ],
    }
    const input = await h.input([rules])
    const reader = input.source
    const adapted = {
      ...input,
      source: {
        ...reader,
        async assertUnchanged(preflight: Parameters<typeof reader.assertUnchanged>[0]) {
          events.push('assert-source')
          await reader.assertUnchanged(preflight)
        },
        readChunk: (table: string, after: Parameters<typeof reader.readChunk>[1], limit: number) =>
          reader.readChunk(table, after, Math.min(limit, 2)),
      },
    }
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(adapted, sink)
      expect(events).toEqual([
        'assert-source',
        'assert-source',
        'lookup',
        'convert',
        'convert',
        'assert-source',
      ])
      expect(summary.status).toBe('converted')
      expect(sink.rows('maintenance_state')).toHaveLength(5)
      expect(summary.tableReceipts[0]).toMatchObject({
        rowsRead: 5,
        counts: { preserved: 5, converted: 0, archived: 0, blocked: 0 },
        exceptions: 0,
        units: 2,
      })
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
      expect([...sink.units.values()].map((unit) => unit.receipt.counts.preserved)).toEqual([3, 2])
      expect([...sink.units.values()][0]!.receipt.lookups).toHaveLength(3)
      expect(summary.plan.coverage).toBe('partial')
    } finally {
      await reader.close()
    }
  }, 180_000)
  test('composite source keys survive non-aligned unit limits and trace round trips', async () => {
    await h.install()
    const rows = ['a', 'b', 'c', 'd', 'e'].map((resource_id, index) => ({
      resource_type: 'workflow',
      resource_id: `${resource_id}:/:["key"]`,
      commit_id: 'commit',
      session_id: 'session',
      created_at: index,
    }))
    await h.write('intent_provenance', rows)
    const input = await h.input([contribution(copyRule('intent_provenance'))], { chunkLimit: 2 })
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(summary.tableReceipts[0]!.rowsRead).toBe(5)
      expect(sink.rows('intent_provenance')).toHaveLength(5)
      const key = [
        { type: 'text' as const, value: 'workflow' },
        { type: 'text' as const, value: 'c:/:["key"]' },
        { type: 'text' as const, value: 'commit' },
      ]
      const explanation = await explainSourceRow(input, 'intent_provenance', key)
      expect(explanation).toMatchObject({
        found: true,
        class: 'preserved',
        sourceKey: encodeMigrationKey('intent_provenance', key),
        dispositions: [],
        blocks: [],
      })
      expect(explanation.targets).toEqual([
        { table: 'intent_provenance', key: explanation.sourceKey },
      ])
      expect(explanation.receipts).toHaveLength(1)
      expect(
        (
          await explainSourceRow(input, 'intent_provenance', [
            ...key.slice(0, 2),
            { type: 'text', value: 'absent' },
          ])
        ).found,
      ).toBe(false)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('a lost commit acknowledgement replays identically; changed watermark, generation and payload are refused', async () => {
    await h.install()
    await h.write('maintenance_state', [
      { key: 'a', value: 'one', updated_at: 1 },
      { key: 'b', value: 'two', updated_at: 2 },
    ])
    const input = await h.input([contribution(copyRule('maintenance_state'))], { chunkLimit: 1 })
    try {
      const sink = new V2MemorySink()
      sink.loseAcknowledgementOnce = true
      await expect(runConversion(input, sink)).rejects.toThrow('lost-acknowledgement')
      expect(sink.units.size).toBe(1)
      const first = [...sink.units.values()][0]!.receipt.digest
      const summary = await runConversion(input, sink)
      expect(summary.status).toBe('converted')
      expect(sink.rows('maintenance_state')).toHaveLength(2)
      expect([...sink.units.values()][0]!.receipt.digest).toBe(first)
      const stable = [...sink.units.values()].map((unit) => unit.receipt.digest)
      await runConversion(input, sink)
      expect([...sink.units.values()].map((unit) => unit.receipt.digest)).toEqual(stable)
      await expect(
        runConversion({ ...input, targetGeneration: 'changed-generation' }, sink),
      ).rejects.toThrow('binding-mismatch')
      const changed = {
        ...input,
        preflight: { ...input.preflight, watermark: 'changed' },
        source: {
          ...input.source,
          assertUnchanged: () => input.source.assertUnchanged(input.preflight),
        },
      }
      await expect(runConversion(changed, sink)).rejects.toThrow('binding-mismatch')
      const original = [...sink.units.values()][0]!
      const { digest: _digest, ...receipt } = original.receipt
      const { receipt: _receipt, ...payload } = original
      const changedPayload = {
        ...payload,
        records: [{ kind: 'decision' as const, code: 'different', payload: null }],
      }
      await expect(
        sink.commitUnit({
          ...changedPayload,
          receipt: {
            ...receipt,
            digest: valueDigest({ receipt, output: encodeStagedValue(changedPayload) }),
          },
        }),
      ).rejects.toThrow('unit-conflict')
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('lookup-driven groups include tasks without members and report orphan members', async () => {
    await h.install()
    await h.write('maintenance_state', [
      { key: 'a', value: 'task-a', updated_at: 1 },
      { key: 'b', value: 'task-a', updated_at: 2 },
      { key: 'orphan', value: 'missing', updated_at: 3 },
    ])
    const seen: string[] = []
    const base = copyRule('maintenance_state')
    const rule: ConversionRule = {
      ...base,
      lookups: [TASK_FACTS, TASK_MOUNTS, RUN_FRAMES],
      unit: {
        kind: 'group',
        driver: TASK_FACTS,
        groupColumn: 'taskId',
        members: [{ table: 'maintenance_state', column: 'value' }],
      },
      convert(unit, ctx) {
        seen.push(...unit.groupKeys!)
        expect(ctx.lookup(TASK_MOUNTS).require('task-a').layout).toBe('none')
        expect(ctx.lookup(RUN_FRAMES).require('run-a').taskId).toBe('task-a')
        base.convert(unit, ctx)
      },
    }
    const input = await h.input([contribution(rule)], {
      fixtures: {
        taskFacts: [taskFacts('task-a'), taskFacts('task-empty')],
        taskMounts: [{ taskId: 'task-a', layout: 'none', mounts: [] }],
        runFrames: [
          {
            runId: 'run-a',
            taskId: 'task-a',
            containerRunId: null,
            scopePath: '',
            iteration: 0,
            quality: 'recorded',
          },
        ],
      },
    })
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(input, sink)
      expect(seen).toEqual(['task-a', 'task-empty'])
      expect(summary.status).toBe('blocked')
      expect(summary.tableReceipts[0]!.counts).toEqual({
        preserved: 2,
        converted: 0,
        archived: 0,
        blocked: 1,
      })
      expect(summary.blocks.map((block) => block.code)).toContain('v2-orphan-group')
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('table-driven grouped rows are emitted once and staged group order is deterministic', async () => {
    await h.install()
    await h.write('maintenance_state', [
      { key: 'b', value: 'x', updated_at: 1 },
      { key: 'a', value: 'y', updated_at: 2 },
    ])
    const base = copyRule('maintenance_state')
    const seen: string[] = []
    const input = await h.input([
      contribution({
        ...base,
        unit: { kind: 'group', driver: 'maintenance_state', groupColumn: 'key', members: [] },
        convert(unit, ctx) {
          seen.push(...unit.groupKeys!)
          base.convert(unit, ctx)
        },
      }),
    ])
    try {
      const summary = await runConversion(input, new V2MemorySink())
      expect(seen).toEqual(['a', 'b'])
      expect(summary.tableReceipts[0]!.counts.preserved).toBe(2)
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('frozen codec failures re-read raw cursors and block only malformed rows, including after a good chunk', async () => {
    await h.install()
    await h.write('recovery_events', [
      { id: 'a', actor: 'fixture', kind: 'first', before_json: '{}', created_at: 1 },
      { id: 'b', actor: 'fixture', kind: 'bad', before_json: '{ invalid', created_at: 2 },
      { id: 'c', actor: 'fixture', kind: 'last', before_json: '{ "a": 1 }', created_at: 3 },
    ])
    const input = await h.input([contribution(copyRule('recovery_events'))], { chunkLimit: 1 })
    let reads = 0
    const reader = input.source
    const instrumented = {
      ...input,
      source: {
        ...reader,
        readRawChunk: async (...args: Parameters<typeof reader.readRawChunk>) => {
          reads++
          return reader.readRawChunk(...args)
        },
      },
    }
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(instrumented, sink)
      expect(reads).toBeGreaterThan(0)
      expect(summary.status).toBe('blocked')
      expect(summary.tableReceipts[0]!.counts).toEqual({
        preserved: 2,
        converted: 0,
        archived: 0,
        blocked: 1,
      })
      expect(sink.rows('recovery_events').map((row) => row.id)).toEqual(['a', 'c'])
      expect(summary.blocks[0]).toMatchObject({
        code: 'v2-source-codec',
        sourceKey: encodeMigrationKey('recovery_events', [{ type: 'text', value: 'b' }]),
        missingFields: ['before_json'],
      })
      expect(
        canonicalSchemaJson([...sink.units.values()].flatMap((unit) => unit.blocks)),
      ).toContain('{ invalid')
    } finally {
      await reader.close()
    }
  }, 180_000)
  test('plan rejects duplicate claims within/across rules and unresolved lookup dependencies', async () => {
    await h.install()
    const rule = copyRule('maintenance_state')
    const input = await h.input([contribution(rule)])
    try {
      expect(() =>
        planConversion({
          ...input,
          contributions: [
            contribution({ ...rule, claims: ['maintenance_state', 'maintenance_state'] }),
          ],
        }),
      ).toThrow('duplicate-claim')
      expect(() =>
        planConversion({
          ...input,
          contributions: [
            contribution(rule),
            contribution({ ...rule, ref: { id: 'other', version: 1 } }),
          ],
        }),
      ).toThrow('duplicate-claim')
      expect(() =>
        planConversion({
          ...input,
          contributions: [contribution({ ...rule, lookups: [TASK_FACTS] })],
        }),
      ).toThrow('missing-lookup')
      const a = lookupKey('a', 1),
        b = lookupKey('b', 1)
      expect(() =>
        planConversion({
          ...input,
          contributions: [
            {
              ...contribution(rule),
              lookups: [
                { key: a, sources: [], dependsOn: [b], build() {} },
                { key: b, sources: [], dependsOn: [a], build() {} },
              ],
            },
          ],
        }),
      ).toThrow('lookup-cycle')
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('validators produce row blocks and unclassified rows cannot disappear', async () => {
    await h.install()
    await h.write('maintenance_state', [
      { key: 'a', value: 'one', updated_at: 1 },
      { key: 'b', value: 'two', updated_at: 2 },
    ])
    const rule = copyRule('maintenance_state')
    const input = await h.input([
      {
        ...contribution({ ...rule, convert() {} }),
        validators: [
          {
            ref: { id: 'fixture/validator', version: 1 },
            table: 'maintenance_state',
            validate(row) {
              return row.values.key === 'a'
                ? [rowBlock('fixture-invalid', row, { why: 'fixture' })]
                : []
            },
          },
        ],
      },
    ])
    try {
      const summary = await runConversion(input, new V2MemorySink())
      expect(summary.tableReceipts[0]!.counts.blocked).toBe(2)
      expect(summary.blocks.map((block) => block.code)).toEqual([
        'fixture-invalid',
        'v2-unclassified-row',
      ])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('same-key dispositions are refused; archive and metadata records account for source rows', async () => {
    await h.install()
    await h.write('maintenance_state', [{ key: 'a', value: 'one', updated_at: 1 }])
    const base = copyRule('maintenance_state')
    const invalid = {
      ...base,
      convert(
        unit: Parameters<ConversionRule['convert']>[0],
        ctx: Parameters<ConversionRule['convert']>[1],
      ) {
        for (const row of unit.rows.get('maintenance_state')!) {
          ctx.out.row('maintenance_state', row.values, row)
          ctx.out.exception({
            sourceTable: row.table,
            sourceKey: row.encodedKey,
            class: 'converted',
            kind: 'same-key' as ExceptionKind,
            targets: [{ table: row.table, key: row.encodedKey }],
            archive: null,
            decision: null,
          })
        }
      },
    }
    const input = await h.input([contribution(invalid)])
    try {
      await expect(runConversion(input, new V2MemorySink())).rejects.toThrow('same-key-disposition')
      const archive: ConversionRule = {
        ...base,
        produces: [],
        unit: { kind: 'raw-chunk', table: 'maintenance_state' },
        convert(unit, ctx) {
          for (const row of unit.rows.get('maintenance_state')!) {
            const ref = ctx.out.archive({
              kind: 'deleted-row',
              sourceTable: row.table,
              format: 'raw-chunk@1',
              bytes: Buffer.from(canonicalSchemaJson(row.raw)),
              rows: 1,
            })
            ctx.out.exception({
              sourceTable: row.table,
              sourceKey: row.encodedKey,
              class: 'archived',
              kind: 'archived',
              targets: [],
              archive: ref,
              decision: { code: 'fixture-archive', detail: null },
            })
          }
        },
      }
      const summary = await runConversion(
        { ...input, contributions: [contribution(archive)] },
        new V2MemorySink(),
      )
      expect(summary.tableReceipts[0]!.counts.archived).toBe(1)
      const metadata: ConversionRule = {
        ...base,
        produces: [],
        convert(unit, ctx) {
          for (const row of unit.rows.get('maintenance_state')!)
            ctx.out.record(
              { kind: 'source-metadata', table: row.table, payload: row.canonical },
              row,
            )
        },
      }
      expect(
        (
          await runConversion(
            { ...input, contributions: [contribution(metadata)] },
            new V2MemorySink(),
          )
        ).records,
      ).toHaveLength(1)
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
