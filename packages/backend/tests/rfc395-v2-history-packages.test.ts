import { expect, test } from 'bun:test'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { describeV2Providers } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues, historyLookups, readFrozenRows } from './helpers/rfc395V2/contentFixtures'
import { seedRequiredRows } from './helpers/rfc395V2/integrationFixtures'
import { archivedHistoryFixture } from './helpers/rfc395V2/archivedHistoryFixtures'
import {
  historyRule,
  historySourceTables,
} from '@/platform/persistence/migration/archives/codeHistory'
import { conversion } from '@/platform/persistence/migration/archives'
import { encodeHistoryPackage } from '@/platform/persistence/migration/archives/package'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import { bytesDigest } from '@/platform/persistence/migration/conversion/digest'
import { decodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import {
  encodeMigrationKey,
  canonicalValue,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { SourceRow } from '@/platform/persistence/migration/conversion/types'

test('history package codec retains typed integer, NULL, bytes and exact JSON text', () => {
  const key = [canonicalValue('id')]
  const values = {
    huge: 9007199254740993n,
    missing: null,
    bytes: new Uint8Array([0, 255]),
    json: ' { "b": 2, "a": 1 }\n',
  }
  const row: SourceRow = {
    table: 'codec-fixture',
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey('codec-fixture', key),
    values,
    canonical: { key, values: Object.values(values).map(canonicalValue) },
    raw: { key, cells: { huge: { storageClass: 'integer', value: canonicalValue(values.huge) } } },
  }
  const input = {
    sourceGeneration: 'generation',
    sourceContract: 'contract',
    table: 'codec-fixture',
    rows: [row],
  }
  const bytes = encodeHistoryPackage(input)
  const decoded = JSON.parse(new TextDecoder().decode(bytes))
  expect(decoded.records[0].canonical.values).toEqual([
    { type: 'integer', value: '9007199254740993' },
    { type: 'null' },
    { type: 'bytes', value: 'AP8=' },
    { type: 'text', value: values.json },
  ])
  expect(decoded.records[0].raw.cells.huge.storageClass).toBe('integer')
  expect(bytesDigest(encodeHistoryPackage(input))).toBe(bytesDigest(bytes))
  expect(bytesDigest(encodeHistoryPackage({ ...input, sourceGeneration: 'other' }))).not.toBe(
    bytesDigest(bytes),
  )
})

describeV2Providers('RFC-395 V2-X history packages', (h) => {
  // PGX-A / U-5: a physical PostgreSQL catalog omits the six RFC-349 tables,
  // but neither native conversion nor a bound export may drop their archived rows.
  test('retained RFC-349 history survives native composition and PostgreSQL export evidence', async () => {
    const fixture = await archivedHistoryFixture(h)
    try {
      const names = [...fixture.originals.keys()]
      for (const source of [fixture.native, fixture.logical]) {
        const input = await h.input(
          [
            {
              rules: names.map((table) => historyRule(table)),
              lookups: [],
              validators: [],
            },
          ],
          { source, chunkLimit: 1 },
        )
        expect(input.preflight.expectedAbsent.filter((table) => names.includes(table))).toEqual([])
        for (const table of names) {
          expect(input.preflight.tables.filter((entry) => entry.table === table)).toHaveLength(1)
          expect(input.preflight.tables.find((entry) => entry.table === table)?.rows).toBe(3)
          const raw = await source.readRawChunk(table, null, 1)
          expect(raw.rows).toHaveLength(1)
        }
        const sink = new V2MemorySink()
        const result = await runConversion(input, sink)
        expect(result.blocks).toEqual([])
        expect(sink.rows('code_history_archives')).toHaveLength(6)
        expect(sink.rows('code_history_id_index')).toHaveLength(18)
        for (const table of names) {
          const archive = sink
            .rows('code_history_archives')
            .find((row) => row.source_table === table)!
          expect(archive.row_count).toBe(3)
          const payload = JSON.parse(
            Buffer.from(archive.content_inline_bytes as Uint8Array).toString(),
          )
          for (const original of fixture.originals.get(table)!) {
            const index = sink
              .rows('code_history_id_index')
              .find(
                (row) =>
                  row.source_table === table &&
                  row.original_key_json === canonicalSchemaJson(original.key),
              )!
            expect(index).toBeDefined()
            expect(payload.records[index.record_ordinal as number].canonical).toEqual(original)
          }
          expect(
            result.tableReceipts.find((receipt) => receipt.sourceTable === table),
          ).toMatchObject({
            rowsRead: 3,
            counts: { archived: 3, blocked: 0, converted: 0, preserved: 0 },
          })
        }
      }
      if (h.sourceHarness.provider === 'postgresql') {
        const preflight = await fixture.native.preflight()
        appendFileSync(join(fixture.retainedRoot, 'logical-manifest.json'), '\n')
        await expect(fixture.native.assertUnchanged(preflight)).rejects.toThrow(
          'Logical source changed',
        )
      }
    } finally {
      await fixture.close()
    }
  }, 300_000)

  test('one package per table including empty and originally absent provider tables', async () => {
    await h.install()
    // PostgreSQL DDL alone omits the rows copied by the epoch-1 install seed.
    await seedRequiredRows(h)
    const input = await h.input([conversion, historyLookups({ adoptions: false })], {
      sourceScope: [
        ...historySourceTables,
        'committed_event_family_cutovers',
        'employee_os_writer_state',
      ],
    })
    try {
      const sink = new V2MemorySink()
      expect((await runConversion(input, sink)).blocks).toEqual([])
      const archives = sink.rows('code_history_archives')
      expect(archives).toHaveLength(13)
      expect(new Set(archives.map((row) => row.source_table)).size).toBe(13)
      expect(archives.every((row) => row.row_count === 0)).toBe(true)
      for (const archive of archives) {
        expect(archive.source_generation).toBe(input.preflight.sourceGenerationId)
        expect(archive.source_contract).toBe(input.preflight.contract!.digest)
        expect(archive.root_digest).toBe(bytesDigest(archive.content_inline_bytes as Uint8Array))
      }
      expect(sink.rows('code_history_id_index')).toEqual([])
      for (const absent of historySourceTables.filter((table) =>
        input.preflight.expectedAbsent.includes(table),
      ))
        expect([...sink.units.values()].flatMap((unit) => unit.records)).toContainEqual(
          expect.objectContaining({
            kind: 'decision',
            code: 'v2-code-history-originally-absent-table',
            payload: expect.objectContaining({ table: absent }),
          }),
        )
    } finally {
      await input.source.close()
    }
  })
  test('non-aligned source chunks form one package, every original ID resolves to its canonical row, replay is stable', async () => {
    await h.install()
    await h.write(
      'code_ai_attempts',
      ['z', 'a', 'é', 'b', 'c'].map((id, index) =>
        frozenValues('code_ai_attempts', {
          id,
          round_id: `round-${id}`,
          status: 'validated',
          validation_outcome: ` { "result": ${index} } `,
          ended_at: 456,
        }),
      ),
    )
    const input = await h.input(
      [{ rules: [historyRule('code_ai_attempts')], lookups: [], validators: [] }],
      { chunkLimit: 2 },
    )
    try {
      const originals = await readFrozenRows(h, 'code_ai_attempts')
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(result.blocks).toEqual([])
      expect(sink.rows('code_history_archives')).toHaveLength(1)
      const archive = sink.rows('code_history_archives')[0]!
      const ref = decodeContentRefColumns(
        archive.content_ref_json as string,
        archive.content_inline_bytes as Uint8Array,
      )!
      expect(ref.kind).toBe('inline')
      expect(archive.root_digest).toBe(bytesDigest(archive.content_inline_bytes as Uint8Array))
      const payload = JSON.parse(
        new TextDecoder().decode(archive.content_inline_bytes as Uint8Array),
      )
      for (const index of sink.rows('code_history_id_index')) {
        const original = originals.find((row) => row.values.id === index.original_id)!
        expect(index.archive_id).toBe(archive.id)
        expect(JSON.parse(index.original_key_json as string)).toEqual(original.key)
        expect(payload.records[index.record_ordinal as number].canonical).toEqual(
          original.canonical,
        )
      }
      expect(sink.rows('code_history_id_index')).toHaveLength(5)
      expect(result.tableReceipts[0]).toMatchObject({
        rowsRead: 5,
        counts: { archived: 5, blocked: 0, converted: 0, preserved: 0 },
      })
      expect(
        [...sink.units.values()]
          .flatMap((unit) => unit.dispositions)
          .every((row) => row.kind === 'archived' && row.archive !== null),
      ).toBe(true)
      const digest = [...sink.units.values()][0]!.receipt.digest
      await runConversion(input, sink)
      expect([...sink.units.values()][0]!.receipt.digest).toBe(digest)
    } finally {
      await input.source.close()
    }
  })
  test('the six ARCHIVE tables retain original rows where the frozen provider installed them', async () => {
    await h.install()
    await seedRequiredRows(h)
    const names = [
      'code_artifacts',
      'code_fix_attempts',
      'code_mr_leases',
      'code_produced_mrs',
      'code_publish_intents',
      'code_work_observations',
    ]
    const source = await h.sourceHarness.source()
    const preflight = await source.preflight()
    await source.close()
    const present = names.filter((table) => preflight.tables.some((entry) => entry.table === table))
    for (const table of present) await h.write(table, [frozenValues(table)])
    const input = await h.input([conversion, historyLookups({ adoptions: false })], {
      sourceScope: [
        ...historySourceTables,
        'committed_event_family_cutovers',
        'employee_os_writer_state',
      ],
    })
    try {
      const sink = new V2MemorySink()
      const result = await runConversion(input, sink)
      expect(result.blocks).toEqual([])
      for (const table of names) {
        const archive = sink
          .rows('code_history_archives')
          .find((row) => row.source_table === table)!
        expect(archive.row_count).toBe(present.includes(table) ? 1 : 0)
        expect(
          sink.rows('code_history_id_index').filter((row) => row.source_table === table),
        ).toHaveLength(present.includes(table) ? 1 : 0)
      }
    } finally {
      await input.source.close()
    }
  })
})
