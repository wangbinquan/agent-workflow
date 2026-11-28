// RFC-626 design §3.4 row 8 and §3.3 "升级后的服务必须能启动". The new version awaits the code
// history query index at startup without a guard; it refuses to start unless each of the 13
// history tables has exactly one package and the index covers every packaged record
// (modules/code-capability/infrastructure/history/queryIndexBuilder.ts, queryIndexManifest.ts).
// Each history table converts as one unit, so one row the frozen codec rejected used to take
// the whole table — and its package — out of the conversion. With automatic resolution the
// history rules take such rows (`takesUndecodedRows`): a row whose rejected cells still have
// their column's type (JSON text that does not parse) is packaged as read with a
// `v2-code-history-kept-undecoded` decision and acknowledged as unfinished; a row the history
// reader could not read back (text in an integer column) is set aside alone. Unfinished rows
// are acknowledged by the upgrade, so no package is withheld. The startup checks are replayed
// read-only against the converted rows. Operator resolution is unchanged.
import { expect, test } from 'bun:test'
import { describeV2Providers, type V2Harness } from './helpers/rfc395V2Harness'
import { V2MemorySink } from './helpers/rfc395V2MemorySink'
import { frozenValues, historyLookups } from './helpers/rfc395V2/contentFixtures'
import { conversion as archives } from '@/platform/persistence/migration/archives'
import { historyAdoptionsLookup } from '@/platform/persistence/migration/archives/adoptions'
import {
  HISTORY_KEPT_UNDECODED,
  historySourceTables,
} from '@/platform/persistence/migration/archives/codeHistory'
import { historyRecordReadable } from '@/platform/persistence/migration/archives/package'
import { unfinishedCodeWork } from '@/platform/persistence/migration/archives/unfinishedWork'
import { runConversion } from '@/platform/persistence/migration/conversion/engine'
import {
  canonicalValue,
  encodeMigrationKey,
} from '@/platform/persistence/migration/conversion/migrationKey'
import type { ConversionInput } from '@/platform/persistence/migration/conversion/plan'
import type { RuleContext } from '@/platform/persistence/migration/conversion/rule'
import type { MigrationRecord, SourceRow } from '@/platform/persistence/migration/conversion/types'
import type { CanonicalLogicalValue } from '@/platform/persistence/migration/legacy/logicalDatabaseArtifact'
import type { LogicalTableContract } from '@/platform/persistence/schema/contractTypes'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'
import {
  CODE_HISTORY_TABLES,
  codeHistoryOriginalId,
  codeHistoryRowSchemas,
  decodeCodeHistoryPackage,
  projectCodeHistoryRow,
  type CodeHistoryQueryTable,
} from '@/modules/code-capability/domain/codeHistoryPackage'

const contract = {
  columns: [
    { name: 'id', logicalCodec: 'text-identity' },
    { name: 'counts_json', logicalCodec: 'json-text' },
    { name: 'ended_at', logicalCodec: 'epoch-milliseconds' },
    { name: 'score', logicalCodec: 'real' },
  ],
} as unknown as LogicalTableContract
function sourceRow(
  cells: readonly CanonicalLogicalValue[],
  failed: readonly string[] | null,
  table = 'code_round_stages',
): SourceRow {
  const key = [cells[0]!]
  return {
    table,
    phase: 'current',
    key,
    encodedKey: encodeMigrationKey(table, key),
    canonical: { key, values: [...cells] },
    values: {},
    ...(failed ? { codecFailure: { message: 'fixture', columns: failed } } : {}),
  }
}
const decoded: readonly CanonicalLogicalValue[] = [
  { type: 'text', value: 'row' },
  { type: 'text', value: '{}' },
  { type: 'integer', value: '456' },
  { type: 'real', value: '1.5' },
]

test('a rejected row is packaged as read only when the history reader can read it back', () => {
  expect(historyRecordReadable(sourceRow(decoded, null), contract)).toBe(true)
  // JSON text that does not parse is still text.
  const json = [
    decoded[0]!,
    { type: 'text', value: '{ invalid' },
    decoded[2]!,
    decoded[3]!,
  ] as const
  expect(historyRecordReadable(sourceRow(json, ['counts_json']), contract)).toBe(true)
  // Text in an integer column, NULL in a required column, a real that is not finite.
  const text = [decoded[0]!, decoded[1]!, { type: 'text', value: 'soon' }, decoded[3]!] as const
  expect(historyRecordReadable(sourceRow(text, ['ended_at']), contract)).toBe(false)
  const missing = [decoded[0]!, decoded[1]!, { type: 'null' }, decoded[3]!] as const
  expect(historyRecordReadable(sourceRow(missing, ['ended_at']), contract)).toBe(false)
  const infinite = [decoded[0]!, decoded[1]!, decoded[2]!, { type: 'real', value: 'Infinity' }]
  expect(historyRecordReadable(sourceRow(infinite as never, ['score']), contract)).toBe(false)
  // A column the contract does not know, or no contract at all.
  expect(historyRecordReadable(sourceRow(json, ['unknown']), contract)).toBe(false)
  expect(historyRecordReadable(sourceRow(json, ['counts_json']), undefined)).toBe(false)
})

test('an undecodable history row counts as unfinished; a decoded finished one does not', () => {
  const stage = (codecFailure: SourceRow['codecFailure'] | undefined): SourceRow => {
    const key = [canonicalValue('stage')]
    return {
      table: 'code_round_stages',
      phase: 'current',
      key,
      encodedKey: encodeMigrationKey('code_round_stages', key),
      canonical: { key, values: [] },
      values: { id: 'stage', status: 'done', ended_at: 456 },
      ...(codecFailure ? { codecFailure } : {}),
    }
  }
  // code_round_stages consults no lookup.
  const ctx = {} as RuleContext
  expect(unfinishedCodeWork(stage(undefined), ctx)).toBeNull()
  expect(
    unfinishedCodeWork(stage({ message: 'fixture', columns: ['counts_json'] }), ctx),
  ).toMatchObject({ code: 'v2-code-history-unfinished', scope: 'row', acknowledgeable: true })
})

/** The startup checks of the code history query index, replayed read-only on converted rows. */
function assertHistoryIndexInitializes(sink: V2MemorySink, input: ConversionInput): void {
  const contract = input.preflight.contract!
  const source = { sourceGeneration: input.preflight.sourceGenerationId, contract }
  const packages = sink.rows('code_history_archives')
  const index = sink.rows('code_history_id_index')
  for (const table of CODE_HISTORY_TABLES) {
    // readCodeHistoryManifest: exactly one package per table.
    const matches = packages.filter(
      (row) =>
        row.source_table === table &&
        row.source_generation === source.sourceGeneration &&
        row.source_contract === contract.digest,
    )
    expect(matches).toHaveLength(1)
    const archive = matches[0]!
    const records = decodeCodeHistoryPackage(
      archive.content_inline_bytes as Uint8Array,
      {
        formatVersion: Number(archive.format_version),
        sourceGeneration: String(archive.source_generation),
        sourceContract: String(archive.source_contract),
        sourceTable: String(archive.source_table),
        rowCount: Number(archive.row_count),
        rootDigest: String(archive.root_digest),
      },
      source,
    )
    // queryIndexBuilder: the index has one entry per record, at the record's ordinal and key.
    const entries = index.filter(
      (row) =>
        row.source_contract === contract.digest &&
        row.source_table === table &&
        row.archive_id === archive.id,
    )
    expect(entries).toHaveLength(records.length)
    expect(new Set(entries.map((row) => row.original_id)).size).toBe(entries.length)
    records.forEach((record, ordinal) => {
      const entry = entries.find(
        (row) => row.original_id === codeHistoryOriginalId(table, record.key),
      )!
      expect(entry.record_ordinal).toBe(ordinal)
      expect(entry.original_key_json).toBe(canonicalSchemaJson(record.key))
      // The query tables are projected by column type; a failure here stops the startup.
      if (table in codeHistoryRowSchemas)
        expect(() =>
          projectCodeHistoryRow(table as CodeHistoryQueryTable, record.row),
        ).not.toThrow()
    })
  }
}
async function historyInput(h: V2Harness): Promise<ConversionInput> {
  return h.input(
    [
      // Only the history rules (the archive contribution's `forSource`), with their lookups.
      {
        rules: [],
        lookups: [historyAdoptionsLookup],
        validators: [],
        forSource: archives.forSource,
      },
      historyLookups({ adoptions: false }),
    ],
    { sourceScope: [...historySourceTables] },
  )
}
const decisions = (sink: V2MemorySink, code: string) =>
  [...sink.units.values()]
    .flatMap((unit) => unit.records)
    .filter(
      (record): record is Extract<MigrationRecord, { kind: 'decision' }> =>
        record.kind === 'decision' && record.code === code,
    )

describeV2Providers('RFC-626 code history with undecodable rows', (h) => {
  test('automatic keeps one package per table and an index the startup accepts', async () => {
    await h.install()
    await h.write('code_round_stages', [
      frozenValues('code_round_stages', {
        id: 'stage-good',
        round_id: 'round',
        stage_seq: 0,
        status: 'done',
        ended_at: 456,
      }),
      frozenValues('code_round_stages', {
        id: 'stage-bad-json',
        round_id: 'round',
        stage_seq: 1,
        status: 'done',
        ended_at: 456,
        counts_json: '{ invalid',
      }),
    ])
    // SQLite keeps whatever was stored: text in an integer column of the first history table,
    // whose rule also writes the zero-row packages of tables the source never had.
    const sqlite = h.sourceHarness.provider === 'sqlite'
    if (sqlite)
      await h.write('code_ai_attempts', [
        frozenValues('code_ai_attempts', {
          id: 'attempt-bad-type',
          round_id: 'round',
          status: 'validated',
          ended_at: 'soon',
        }),
      ])
    const input = await historyInput(h)
    try {
      const sink = new V2MemorySink()
      const summary = await runConversion({ ...input, resolution: 'automatic' }, sink)
      expect(summary.blocks).toEqual([])
      expect(summary.status).toBe('converted')
      assertHistoryIndexInitializes(sink, input)

      const stages = sink
        .rows('code_history_archives')
        .find((row) => row.source_table === 'code_round_stages')!
      expect(stages.row_count).toBe(2)
      const badKey = encodeMigrationKey('code_round_stages', [canonicalValue('stage-bad-json')])
      expect(decisions(sink, HISTORY_KEPT_UNDECODED)).toEqual([
        expect.objectContaining({
          payload: expect.objectContaining({
            automatic: 'kept',
            sourceTable: 'code_round_stages',
            sourceKey: badKey,
            columns: ['counts_json'],
          }),
        }),
      ])
      // The upgrade acknowledged it as unfinished work, exactly like an operator would.
      expect(decisions(sink, 'v2-code-history-unfinished')).toContainEqual(
        expect.objectContaining({
          payload: expect.objectContaining({ automatic: 'acknowledged', sourceKey: badKey }),
        }),
      )
      const dispositions = [...sink.units.values()].flatMap((unit) => unit.dispositions)
      expect(dispositions).toContainEqual(
        expect.objectContaining({
          sourceKey: badKey,
          class: 'archived',
          kind: 'archived',
          decision: expect.objectContaining({ code: 'v2-code-history-acknowledged-unfinished' }),
        }),
      )
      expect(
        summary.tableReceipts.find((receipt) => receipt.sourceTable === 'code_round_stages')!
          .counts,
      ).toEqual({ converted: 0, preserved: 0, archived: 2, blocked: 0 })

      if (sqlite) {
        // The unreadable row is set aside alone; the package of its table still exists.
        expect(
          sink.rows('code_history_archives').find((row) => row.source_table === 'code_ai_attempts')!
            .row_count,
        ).toBe(0)
        const attemptKey = encodeMigrationKey('code_ai_attempts', [
          canonicalValue('attempt-bad-type'),
        ])
        expect(dispositions).toContainEqual(
          expect.objectContaining({
            sourceKey: attemptKey,
            class: 'archived',
            kind: 'archived',
            targets: [],
            decision: expect.objectContaining({ code: 'v2-source-codec' }),
          }),
        )
        expect(decisions(sink, 'v2-row-set-aside')).toContainEqual(
          expect.objectContaining({ payload: expect.objectContaining({ sourceKey: attemptKey }) }),
        )
      }
      for (const absent of historySourceTables.filter((table) =>
        input.preflight.expectedAbsent.includes(table),
      ))
        expect(decisions(sink, 'v2-code-history-originally-absent-table')).toContainEqual(
          expect.objectContaining({ payload: expect.objectContaining({ table: absent }) }),
        )

      // Operator resolution: the undecodable row still blocks its whole table's package.
      const manualSink = new V2MemorySink()
      const manual = await runConversion(input, manualSink)
      expect(manual.status).toBe('blocked')
      expect(manual.blocks).toContainEqual(
        expect.objectContaining({ code: 'v2-source-codec', sourceKey: badKey }),
      )
      expect(
        manualSink
          .rows('code_history_archives')
          .some((row) => row.source_table === 'code_round_stages'),
      ).toBe(false)
      expect(decisions(manualSink, HISTORY_KEPT_UNDECODED)).toEqual([])
    } finally {
      await input.source.close()
    }
  }, 300_000)
})
