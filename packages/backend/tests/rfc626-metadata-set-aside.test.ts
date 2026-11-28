// RFC-626 design §3.4 row 16 (and §3.3 "自动处置之后校验必须通过"). A malformed `sqlite_sequence`
// row (`v2-identity-sequence-invalid`) or `database_generations` row
// (`v2-source-generation-invalid`) is a row-level block, so automatic resolution sets the row
// aside: it goes to an archive with its raw evidence and records nothing else. In particular the
// set-aside sequence contributes no identity high-water record, which leaves the target's own
// maximum row (`target/identity.ts`, basis `max-row`) as the high water for that table.
// Operator resolution keeps both blocks.
import { expect, test } from 'bun:test'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { sourceTableRules } from '@/platform/persistence/migration/conversion/generic/sourceTables'
import { identityMaxima } from '@/platform/persistence/migration/conversion/generic/identityHighWater'
import { foldIdentityHighWater } from '@/platform/persistence/migration/target/identity'
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
function metadata(table: string, physicalTable = table): SourceTableDisposition {
  return {
    table,
    physicalTable,
    rows: 1,
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
/** The physical metadata rows are served through the raw channel, as a reader would. */
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

describeV2Providers('RFC-626 malformed sequence and generation metadata', (h) => {
  test('automatic sets both rows aside and leaves the high water to the maximum row', async () => {
    await h.install()
    const input = await h.input([dynamic])
    const tables = [
      metadata('sqlite_sequence'),
      metadata('database_generations', 'agent_workflow_meta.database_generations'),
    ]
    const fixture = physicalFixture(input.source, input.preflight, tables, {
      sqlite_sequence: [
        {
          key: [{ type: 'integer', value: '1' }],
          cells: {
            name: rawSourceCell('text', 'node_run_events'),
            seq: rawSourceCell('text', 'not-an-integer'),
          },
        },
      ],
      database_generations: [
        {
          key: [{ type: 'integer', value: '1' }],
          cells: { generation_id: rawSourceCell('null', null) },
        },
      ],
    })
    const run = { ...input, ...fixture, sourceScope: tables.map((entry) => entry.table) }
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...run, resolution: 'automatic' }, sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      expect(summary.tableReceipts.every((receipt) => receipt.counts.archived === 1)).toBe(true)
      const units = [...sink.units.values()]
      const dispositions = units.flatMap((unit) => unit.dispositions)
      expect(dispositions.map((entry) => entry.decision?.code).sort()).toEqual([
        'v2-identity-sequence-invalid',
        'v2-source-generation-invalid',
      ])
      for (const disposition of dispositions) {
        expect(disposition).toMatchObject({ class: 'archived', kind: 'archived', targets: [] })
        const archive = units
          .flatMap((unit) => unit.archives)
          .find((entry) => entry.ref === disposition.archive)!
        expect(archive).toMatchObject({ format: 'logical-row@1', rows: 1 })
      }
      expect(
        Buffer.from(
          units
            .flatMap((unit) => unit.archives)
            .find((entry) => entry.sourceTable === 'sqlite_sequence')!.bytes,
        ).toString('utf8'),
      ).toContain('not-an-integer')
      // The set-aside rows record neither a sequence nor a generation.
      expect(
        summary.records.filter(
          (record) =>
            record.kind === 'identity-high-water' ||
            record.kind === 'source-generation' ||
            record.kind === 'source-metadata',
        ),
      ).toEqual([])
      expect(
        foldIdentityHighWater(summary.records).some((entry) => entry.table === 'node_run_events'),
      ).toBe(false)

      const manual = await runConversion(run, new V2MemorySink())
      expect(manual.blocks.map((block) => block.code).sort()).toEqual([
        'v2-identity-sequence-invalid',
        'v2-source-generation-invalid',
      ])
    } finally {
      await input.source.close()
    }
  }, 180_000)
})
