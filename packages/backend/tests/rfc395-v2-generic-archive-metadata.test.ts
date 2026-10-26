import { expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { sourceTableRules } from '@/platform/persistence/migration/conversion/generic/sourceTables'
import { openDispositionEvidenceSource } from '@/platform/persistence/migration/conversion/generic/dispositionSource'
import { identityMaxima } from '@/platform/persistence/migration/conversion/generic/identityHighWater'
import { captureSourceDispositionRows } from '@/platform/persistence/migration/sourceDispositionEvidence'
import { rawSourceCell, rawSourceChunk } from '@/platform/persistence/migration/rawSourceReader'
import type { ConversionContribution } from '@/platform/persistence/migration/conversion/rule'
import type {
  RawSourceRow,
  SourcePreflight,
  SourceTableDisposition,
  VersionedSourceReader,
} from '@/platform/persistence/migration/sourceTypes'

const dynamic: ConversionContribution = {
  rules: [],
  lookups: [identityMaxima],
  validators: [],
  forSource: sourceTableRules,
}

function physicalFixture(
  base: VersionedSourceReader,
  original: SourcePreflight,
  tables: readonly SourceTableDisposition[],
  data: Readonly<Record<string, readonly RawSourceRow[]>>,
): { source: VersionedSourceReader; preflight: SourcePreflight } {
  const preflight = {
    ...original,
    tables: [
      ...original.tables.filter((entry) => !tables.some((table) => table.table === entry.table)),
      ...tables,
    ],
  }
  return {
    preflight,
    source: {
      ...base,
      async preflight() {
        return preflight
      },
      async assertUnchanged() {
        await base.assertUnchanged(original)
      },
      async readRawChunk(table, afterKey, limit) {
        if (!Object.hasOwn(data, table)) return base.readRawChunk(table, afterKey, limit)
        const rows = data[table]!
        const start =
          afterKey === null
            ? 0
            : rows.findIndex((row) => JSON.stringify(row.key) === JSON.stringify(afterKey)) + 1
        return rawSourceChunk({
          sourceVersion: original.sourceVersion,
          table,
          migrationKey: ['raw-ordinal'],
          afterKey,
          rows: rows.slice(start, start + limit),
        })
      },
      async readChunk(table, afterKey, limit) {
        if (Object.hasOwn(data, table))
          throw new Error('Non-roster physical evidence must use raw reads')
        return base.readChunk(table, afterKey, limit)
      },
    },
  }
}

function rawRow(
  key: number,
  values: Record<string, ReturnType<typeof rawSourceCell>>,
): RawSourceRow {
  return { key: [{ type: 'integer', value: String(key) }], cells: values }
}
function archived(
  table: string,
  rows: number,
  reason = 'reviewed archive decision',
): SourceTableDisposition {
  return {
    table,
    physicalTable: table,
    rows,
    disposition: 'archived',
    destination: { kind: 'archive' },
    reason,
  }
}
function metadata(table: string, rows: number, physicalTable = table): SourceTableDisposition {
  return {
    table,
    physicalTable,
    rows,
    disposition: 'metadata',
    destination: {
      kind: 'migration-records',
      records:
        table === 'sqlite_sequence'
          ? ['identity']
          : table === 'database_generations'
            ? ['activation']
            : ['migration'],
    },
    reason: 'V1 metadata destination',
  }
}

describeV2Providers('RFC-395 V2 raw archives and metadata', (h) => {
  test('nonempty retired and decided unknown tables archive typed raw rows; empty decided table gets a zero-row receipt', async () => {
    await h.install()
    const input = await h.input([dynamic])
    const raw = rawRow(1, {
      large: rawSourceCell('integer', 9007199254740993n),
      bytes: rawSourceCell('blob', new Uint8Array([0, 255, 128])),
      json: rawSourceCell('text', ' { "b":2, "a":1 }\n'),
      missing: rawSourceCell('null', null),
      empty: rawSourceCell('text', ''),
      real: { storageClass: 'real', value: { type: 'real', value: '-0' } },
    })
    const tables = [
      archived(
        'retired_table',
        1,
        'frozen historical table: archive pre-upgrade rows before the chain removes it',
      ),
      archived('reviewed_extra', 1),
      archived('empty_extra', 0),
    ]
    const fixture = physicalFixture(input.source, input.preflight, tables, {
      retired_table: [raw],
      reviewed_extra: [raw],
      empty_extra: [],
    })
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(
        { ...input, ...fixture, sourceScope: tables.map((entry) => entry.table), chunkLimit: 1 },
        sink,
      )
      expect(summary.status).toBe('converted')
      const archives = [...sink.units.values()].flatMap((unit) => unit.archives)
      expect(archives).toHaveLength(3)
      expect(archives.find((archive) => archive.sourceTable === 'retired_table')!.kind).toBe(
        'retired-table',
      )
      expect(archives.find((archive) => archive.sourceTable === 'empty_extra')!.rows).toBe(0)
      for (const archive of archives.filter((archive) => archive.rows))
        expect(JSON.parse(Buffer.from(archive.bytes).toString()).rows).toEqual([raw])
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'empty_extra'),
      ).toMatchObject({
        rowsRead: 0,
        units: 1,
        counts: { converted: 0, preserved: 0, archived: 0, blocked: 0 },
      })
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toHaveLength(2)
      expect([...sink.units.values()].flatMap((unit) => unit.rows)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('unknown empty and nonempty tables without decisions both block', async () => {
    await h.install()
    const input = await h.input([dynamic])
    try {
      for (const count of [0, 1]) {
        const declaration: SourceTableDisposition = {
          ...archived('unreviewed', count),
          disposition: 'blocked',
          destination: { kind: 'blocked' },
          reason: 'no source decision',
        }
        const fixture = physicalFixture(input.source, input.preflight, [declaration], {
          unreviewed: [],
        })
        const sink = new V2MemorySink()
        const summary = await runConversion(
          { ...input, ...fixture, sourceScope: ['unreviewed'] },
          sink,
        )
        expect(summary.status).toBe('blocked')
        expect(summary.blocks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              code: 'v2-unknown-table-without-decision',
              sourceTable: 'unreviewed',
            }),
          ]),
        )
        expect([...sink.units.values()].flatMap((unit) => unit.archives)).toEqual([])
      }
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('dropped tables are reopened from persisted V1 pre-upgrade chunks and rechunked without source access', async () => {
    await h.install()
    const input = await h.input([dynamic])
    const rows = [1, 2, 3, 4, 5].map((key) =>
      rawRow(key, {
        bytes: rawSourceCell('bytea', Buffer.from([key, 0, 255])),
        legacy: rawSourceCell('text', ` original ${key}\n`),
      }),
    )
    const table = archived(
      'dropped_table',
      rows.length,
      'frozen historical table: archive pre-upgrade rows before the chain removes it',
    )
    const fixture = physicalFixture(input.source, input.preflight, [table], { dropped_table: rows })
    const directory = join(h.sourceHarness.operationRoot, 'v2-captured-dispositions')
    mkdirSync(directory, { recursive: true })
    try {
      await captureSourceDispositionRows(
        fixture.source,
        { ...fixture.preflight, tables: [table] },
        directory,
      )
      const before = openDispositionEvidenceSource(directory)
      const beforePreflight = await before.preflight()
      const sink = new V2MemorySink()
      try {
        const summary = await runConversion(
          {
            ...input,
            sourceScope: [],
            preUpgradeSource: before,
            preUpgradePreflight: beforePreflight,
            chunkLimit: 2,
          },
          sink,
        )
        expect(summary.status).toBe('converted')
        expect(summary.tableReceipts).toEqual([
          expect.objectContaining({
            sourceTable: 'dropped_table',
            sourcePhase: 'pre-upgrade',
            rowsRead: 5,
            units: 3,
            counts: { converted: 0, preserved: 0, archived: 5, blocked: 0 },
          }),
        ])
        const archives = [...sink.units.values()].flatMap((unit) => unit.archives)
        expect(archives.every((archive) => archive.kind === 'dropped-by-chain')).toBe(true)
        expect(
          archives.flatMap((archive) => JSON.parse(Buffer.from(archive.bytes).toString()).rows),
        ).toEqual(rows)
        const evidence = JSON.parse(readFileSync(join(directory, 'dispositions.json'), 'utf8')) as {
          chunks: { path: string }[]
        }[]
        const path = evidence[0]!.chunks[0]!.path
        writeFileSync(path, readFileSync(path, 'utf8').replace(' original 1', ' changed 1'))
        await expect(before.assertUnchanged(beforePreflight)).rejects.toThrow()
      } finally {
        await before.close()
      }
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('sequences, journals, stats, namespaced metadata and generation lineage become migration records', async () => {
    await h.install()
    const input = await h.input([dynamic])
    const tables = [
      metadata('sqlite_sequence', 1),
      metadata('__drizzle_migrations', 1),
      metadata('sqlite_stat4', 1),
      metadata('logical_copy_chunks', 1, 'agent_workflow_meta.logical_copy_chunks'),
      metadata('database_generations', 1, 'agent_workflow_meta.database_generations'),
    ]
    const data = {
      sqlite_sequence: [
        rawRow(1, {
          name: rawSourceCell('text', 'memory_distill_events'),
          seq: rawSourceCell('integer', 9007199254740993n),
        }),
      ],
      __drizzle_migrations: [
        rawRow(1, {
          id: rawSourceCell('integer', 12n),
          hash: rawSourceCell('text', 'original-journal-hash'),
        }),
      ],
      sqlite_stat4: [rawRow(1, { sample: rawSourceCell('blob', new Uint8Array([255, 0, 128])) })],
      logical_copy_chunks: [rawRow(1, { receipt: rawSourceCell('text', ' { "row":1 }\n') })],
      database_generations: [
        rawRow(1, {
          generation_id: rawSourceCell('text', 'dbg_original'),
          state: rawSourceCell('text', 'active'),
          source_generation_id: rawSourceCell('text', 'dbg_ancestor'),
        }),
      ],
    }
    const fixture = physicalFixture(input.source, input.preflight, tables, data)
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion(
        { ...input, ...fixture, sourceScope: tables.map((entry) => entry.table) },
        sink,
      )
      expect(summary.status).toBe('converted')
      expect(summary.records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: 'identity-high-water',
            table: 'memory_distill_events',
            column: 'id',
            value: '9007199254740993',
          }),
          expect.objectContaining({
            kind: 'source-generation',
            generationId: 'dbg_original',
            evidence: expect.objectContaining({
              sourceTable: 'agent_workflow_meta.database_generations',
              raw: expect.stringContaining('dbg_ancestor'),
            }),
          }),
        ]),
      )
      expect(summary.records.filter((record) => record.kind === 'source-journal')).toHaveLength(3)
      expect(summary.tableReceipts.every((receipt) => receipt.counts.converted === 1)).toBe(true)
      expect([...sink.units.values()].flatMap((unit) => unit.rows)).toEqual([])
      expect([...sink.units.values()].flatMap((unit) => unit.dispositions)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 180_000)
  test('malformed sequence and generation metadata produce row blocks with raw evidence', async () => {
    await h.install()
    const input = await h.input([dynamic])
    const tables = [metadata('sqlite_sequence', 1), metadata('database_generations', 1)]
    const fixture = physicalFixture(input.source, input.preflight, tables, {
      sqlite_sequence: [
        rawRow(1, {
          name: rawSourceCell('text', 'node_run_events'),
          seq: rawSourceCell('text', 'not-an-integer'),
        }),
      ],
      database_generations: [rawRow(1, { generation_id: rawSourceCell('null', null) })],
    })
    try {
      const summary = await runConversion(
        { ...input, ...fixture, sourceScope: tables.map((entry) => entry.table) },
        new V2MemorySink(),
      )
      expect(summary.status).toBe('blocked')
      expect(summary.blocks.map((block) => block.code).sort()).toEqual([
        'v2-identity-sequence-invalid',
        'v2-source-generation-invalid',
      ])
      expect(summary.tableReceipts.every((receipt) => receipt.counts.blocked === 1)).toBe(true)
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
