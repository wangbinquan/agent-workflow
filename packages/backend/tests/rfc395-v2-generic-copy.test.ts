import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { ensureIdentitySeeds } from './rfc395-v2-generic-fixtures.test'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { preservedRule } from '@/platform/persistence/migration/conversion/generic/preserved'
import { genericCopyTables } from '@/platform/persistence/migration/conversion/generic/tables'
import { conversion } from '@/platform/persistence/migration/conversion/generic'
import { persistenceSchema } from '@/bootstrap/persistenceSchema'
import roster from '@/bootstrap/targetSchemaRoster.json'
import drift from './fixtures/rfc395-sqlite-drift.json'
import { frozenEpoch1Contract } from '@/platform/persistence/migration/epoch1/contract'
import { frozenEpoch1Registry } from '@/platform/persistence/migration/epoch1/definitions'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import {
  targetRegistryView,
  validateTargetRow,
} from '@/platform/persistence/migration/conversion/targetRows'
import type { TargetValue } from '@/platform/persistence/migration/conversion/types'

function copies(...tables: string[]): ConversionContribution {
  return { rules: tables.map(preservedRule), lookups: [], validators: [] }
}

test('all 176 reused targets retain named columns; the five domain exceptions are not generic claims', () => {
  const reused = roster.filter((entry) => entry.definition === 'reused')
  expect(reused).toHaveLength(176)
  expect(genericCopyTables).toHaveLength(169)
  const reordered = drift.differences.filter((entry) => entry.kind === 'column-order')
  expect(reordered).toHaveLength(42)
  for (const entry of reordered.filter((entry) =>
    (genericCopyTables as readonly string[]).includes(entry.table),
  ))
    expect(conversion.rules.find((rule) => rule.claims.includes(entry.table))!.produces).toEqual([
      { table: entry.table },
    ])
  for (const entry of reused) {
    const source = frozenEpoch1Contract.tables.find((table) => table.id === entry.table)!
    const target = persistenceSchema.tables.find((table) => table.id === entry.table)!
    expect(
      Object.values(target.columns)
        .map((column) => column.name)
        .sort(),
    ).toEqual(source.columns.map((column) => column.name).sort())
  }
  for (const table of [
    'task_space_nodes',
    'node_run_seq_allocations',
    'resource_grants',
    'intent_apply_journal',
    'resource_bundle_applies',
  ])
    expect((genericCopyTables as readonly string[]).includes(table)).toBe(false)
})

test('each enum and bool on all reused definitions is rejected by the injected target codecs', () => {
  const target = targetRegistryView(persistenceSchema)
  let profiled = 0
  for (const entry of roster.filter((entry) => entry.definition === 'reused')) {
    const columns = Object.values(target.table(entry.table).columns)
    const values = Object.fromEntries(
      columns.map((column): [string, TargetValue] => [
        column.name,
        column.nullable
          ? null
          : column.codec === 'bool'
            ? false
            : column.codec === 'enum'
              ? column.enumValues![0]!
              : ['int', 'identity', 'seq', 'epochMs', 'durationMs', 'real'].includes(column.codec)
                ? 1
                : column.codec === 'bigint'
                  ? 1n
                  : column.codec === 'bytes'
                    ? new Uint8Array()
                    : ['jsonText', 'jsonDoc', 'rawJson'].includes(column.codec)
                      ? '{}'
                      : 'fixture',
      ]),
    )
    for (const column of columns.filter((column) => ['enum', 'bool'].includes(column.codec))) {
      expect(() =>
        validateTargetRow(target, entry.table, {
          ...values,
          [column.name]: column.codec === 'bool' ? 2 : '__outside_enum__',
        }),
      ).toThrow(`v2-target-codec: ${entry.table}.${column.name}`)
      profiled++
    }
  }
  expect(profiled).toBeGreaterThan(100)
})

describeV2Providers('RFC-395 V2 generic copy', (h) => {
  test('169 registered generic copies and the named-column copier preserve values without row dispositions', async () => {
    await h.install()
    await ensureIdentitySeeds(h)
    await h.write('runtimes', [
      {
        id: 'copy-runtime',
        name: 'copy runtime',
        protocol: 'opencode',
        enabled: false,
        is_sandbox: true,
        model: '',
        binary_path: null,
        temperature: -0,
        extra_args_json: ' [ "z", "a" ]\n',
        last_probe_json: '{ "2": 2, "1": 1, "z": null }',
        created_at: 11,
        updated_at: 17,
      },
    ])
    const input = await h.input([conversion, copies('runtimes')], {
      sourceScope: [...genericCopyTables, 'runtimes'],
      chunkLimit: 1,
    })
    try {
      const before = (await input.source.readChunk('runtimes', null, 10000)).decodedRows
      const reader = input.source
      // Exercise every copied row with the physical name map enumerated in reverse.
      const source = {
        ...reader,
        async readChunk(
          table: string,
          after: Parameters<typeof reader.readChunk>[1],
          limit: number,
        ) {
          const chunk = await reader.readChunk(table, after, limit)
          return {
            ...chunk,
            decodedRows: chunk.decodedRows.map((row) =>
              Object.fromEntries(
                Object.entries(
                  row.id === 'copy-runtime' ? { ...row, temperature: -0 } : row,
                ).reverse(),
              ),
            ),
          }
        },
      }
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, source }, sink)
      expect(summary.status).toBe('converted')
      expect(summary.tableReceipts).toHaveLength(170)
      expect(sink.rows('runtimes')).toEqual(
        expect.arrayContaining(
          before.map((row) => (row.id === 'copy-runtime' ? { ...row, temperature: -0 } : row)),
        ),
      )
      expect(
        Object.is(sink.rows('runtimes').find((row) => row.id === 'copy-runtime')!.temperature, -0),
      ).toBe(true)
      expect(sink.rows('runtimes').find((row) => row.id === 'copy-runtime')).toMatchObject({
        model: '',
        binary_path: null,
        enabled: false,
        is_sandbox: true,
        extra_args_json: ' [ "z", "a" ]\n',
        last_probe_json: '{ "2": 2, "1": 1, "z": null }',
      })
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
      for (const receipt of summary.tableReceipts)
        expect(receipt.counts.preserved).toBe(receipt.rowsRead)
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('continuity preserves event ids, sequences, dedupe keys, lease epochs and completed delivery state', async () => {
    await h.install()
    await h.write('committed_events', [
      {
        id: 'event:old',
        event_group_id: 'group',
        event_group_ordinal: 3,
        producer: 'task-execution',
        family: 'task-lifecycle',
        event_type: 'completed',
        schema_version: 1,
        aggregate_kind: 'task',
        aggregate_id: 'task',
        aggregate_seq: 37,
        operation_ref: 'operation:/',
        occurred_at: 12,
        payload_json: '{ "z": 2, "a": 1 }\n',
        payload_digest: `canonical-hex-v1:${Buffer.from('{ "z": 2, "a": 1 }\n').toString('hex')}`,
        delivery_mode: 'dispatchable',
        producer_epoch: 9,
        created_at: 13,
      },
    ])
    await h.write('committed_event_deliveries', [
      {
        event_id: 'event:old',
        consumer_id: 'consumer',
        delivery_class: 'critical',
        state: 'accepted',
        attempt_count: 2,
        next_attempt_at: 14,
        claimed_by: 'old-owner',
        lease_epoch: 23,
        claim_expires_at: 15,
        replay_generation: 4,
        created_at: 13,
        updated_at: 16,
        accepted_at: 16,
      },
    ])
    await h.write('maintenance_state', [
      { key: 'dedupe:/', value: '{ "receipt":"old", "cursor":"c:7" }', updated_at: 16 },
    ])
    const input = await h.input(
      [copies('committed_events', 'committed_event_deliveries', 'maintenance_state')],
      { chunkLimit: 1 },
    )
    try {
      const expected = new Map(
        await Promise.all(
          input.sourceScope!.map(
            async (table) =>
              [table, (await input.source.readChunk(table, null, 10000)).decodedRows] as const,
          ),
        ),
      )
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).status).toBe('converted')
      for (const [table, rows] of expected)
        expect(sink.rows(table)).toEqual(expect.arrayContaining(rows))
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('every reused enum/bool column rejects illegal values with column/value evidence', async () => {
    await h.install()
    await h.write('runtimes', [
      {
        id: 'invalid-runtime',
        name: 'invalid runtime',
        protocol: 'opencode',
        created_at: 1,
        updated_at: 1,
      },
    ])
    const input = await h.input([copies('runtimes')])
    try {
      for (const [column, value] of [
        ['protocol', 'unknown-protocol'],
        ['enabled', 2],
      ] as const) {
        const reader = input.source
        const source = {
          ...reader,
          async readChunk(
            table: string,
            after: Parameters<typeof reader.readChunk>[1],
            limit: number,
          ) {
            const chunk = await reader.readChunk(table, after, limit)
            return {
              ...chunk,
              decodedRows: chunk.decodedRows.map((row) =>
                row.id === 'invalid-runtime' ? { ...row, [column]: value } : row,
              ),
            }
          },
        }
        const sink = new V2MemorySink()
        const summary = await runConversion({ ...input, source }, sink)
        expect(summary.status).toBe('blocked')
        expect(summary.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'v2-target-codec',
              missingFields: [column],
              detail: expect.objectContaining({
                column,
                value: expect.objectContaining({
                  value: String(value) === value ? value : String(value),
                }),
              }),
            }),
          ]),
        )
        expect(sink.rows('runtimes').some((row) => row.id === 'invalid-runtime')).toBe(false)
      }
      // Same codecs cover all reused declarations, including tables with no epoch-1 native CHECK.
      for (const table of frozenEpoch1Registry.tables.filter((table) =>
        (genericCopyTables as readonly string[]).includes(table.id),
      )) {
        const target = persistenceSchema.tables.find((entry) => entry.id === table.id)!
        for (const column of Object.values(table.columns).filter((column) =>
          ['enum', 'bool'].includes(column.codec),
        ))
          expect(
            Object.values(target.columns).find((entry) => entry.name === column.name),
          ).toMatchObject({
            codec: column.codec,
            ...(column.enumValues ? { enumValues: column.enumValues } : {}),
          })
      }
    } finally {
      await input.source.close()
    }
  }, 180_000)

  test('PostgreSQL boolean text and SQLite booleans survive raw fallback beside invalid JSON and unsafe integers', async () => {
    await h.install()
    await h.write('runtimes', [
      {
        id: 'a-valid',
        name: 'valid',
        enabled: true,
        is_sandbox: false,
        protocol: 'opencode',
        extra_args_json: ' [1] ',
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'b-json',
        name: 'json',
        protocol: 'opencode',
        extra_args_json: '{broken',
        created_at: 1,
        updated_at: 1,
      },
      {
        id: 'c-int',
        name: 'integer',
        protocol: 'opencode',
        probe_fence: 9007199254740993n,
        created_at: 1,
        updated_at: 1,
      },
    ])
    const input = await h.input([copies('runtimes')], { chunkLimit: 2 })
    let rawReads = 0
    try {
      const reader = input.source
      const source = {
        ...reader,
        async readRawChunk(...args: Parameters<typeof reader.readRawChunk>) {
          rawReads++
          const chunk = await reader.readRawChunk(...args)
          if (h.sourceHarness.provider === 'postgresql')
            for (const row of chunk.rows)
              if (row.cells.id?.value.type === 'text' && row.cells.id.value.value === 'a-valid') {
                expect(row.cells.enabled).toEqual({
                  storageClass: 'boolean',
                  value: { type: 'text', value: 'true' },
                })
                expect(row.cells.is_sandbox).toEqual({
                  storageClass: 'boolean',
                  value: { type: 'text', value: 'false' },
                })
              }
          return chunk
        },
      }
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, source }, sink)
      expect(rawReads).toBeGreaterThan(0)
      expect(summary.blocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'v2-source-codec', missingFields: ['extra_args_json'] }),
          expect.objectContaining({ code: 'v2-target-codec', missingFields: ['probe_fence'] }),
        ]),
      )
      expect(sink.rows('runtimes').find((row) => row.id === 'a-valid')).toMatchObject({
        enabled: true,
        is_sandbox: false,
      })
      expect(sink.rows('runtimes').find((row) => row.id === 'a-valid')!.extra_args_json).toBe(
        ' [1] ',
      )
      expect(sink.rows('runtimes').some((row) => row.id === 'b-json' || row.id === 'c-int')).toBe(
        false,
      )
      expect(summary.tableReceipts[0]!.counts.blocked).toBe(2)
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
