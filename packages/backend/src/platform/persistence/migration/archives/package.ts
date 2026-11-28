import { canonicalSchemaJson } from '../../schema/canonical'
import { legacyLocationToContentRef } from '../conversion/content'
import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { bytesDigest } from '../conversion/digest'
import { canonicalValue, encodeMigrationKey } from '../conversion/migrationKey'
import type { RuleContext } from '../conversion/rule'
import type { SourceRow, TargetRow } from '../conversion/types'
import type { LogicalCodec, LogicalTableContract } from '../../schema/contractTypes'
import type { CanonicalLogicalValue } from '../legacy/logicalDatabaseArtifact'

/** The canonical cell each logical codec writes for a non-NULL value. */
const codecCells: Readonly<Record<LogicalCodec, CanonicalLogicalValue['type']>> = {
  boolean: 'boolean',
  'epoch-milliseconds': 'integer',
  integer: 'integer',
  'json-text': 'text',
  'opaque-bytes': 'bytes',
  real: 'real',
  text: 'text',
  'text-identity': 'text',
}
/**
 * RFC-626 §3.4 row 8: whether a row the frozen codec rejected can still go into its history
 * package as it was read. The new version validates every packaged cell and projects the
 * records of its query tables by column type when it builds the history index at startup, and
 * it does not start when that fails. A rejected cell that still has its column's type — JSON
 * text that does not parse — reads back; one of another type (text in an integer column, a
 * NULL in a required column, a real that is not finite) does not, and its row is set aside
 * instead so the package stays readable.
 */
export function historyRecordReadable(
  row: SourceRow,
  contract: LogicalTableContract | undefined,
): boolean {
  if (!row.codecFailure) return true
  if (!contract) return false
  return row.codecFailure.columns.every((name) => {
    const index = contract.columns.findIndex((column) => column.name === name)
    const cell = index < 0 ? undefined : row.canonical.values[index]
    if (!cell || cell.type !== codecCells[contract.columns[index]!.logicalCodec]) return false
    return cell.type !== 'real' || Number.isFinite(Number(cell.value))
  })
}

export function encodeHistoryPackage(input: {
  readonly sourceGeneration: string
  readonly sourceContract: string
  readonly table: string
  readonly rows: readonly SourceRow[]
}): Uint8Array {
  return new TextEncoder().encode(
    canonicalSchemaJson({
      format: 'code-history@1',
      sourceGeneration: input.sourceGeneration,
      sourceContract: input.sourceContract,
      table: input.table,
      records: [...input.rows]
        .sort((a, b) => (a.encodedKey < b.encodedKey ? -1 : a.encodedKey > b.encodedKey ? 1 : 0))
        .map((row) => ({ key: row.key, canonical: row.canonical, raw: row.raw ?? null })),
    }),
  )
}

export function packageHistoryTable(
  table: string,
  rows: readonly SourceRow[],
  ctx: RuleContext,
): {
  readonly archive: TargetRow
  readonly index: readonly {
    readonly row: SourceRow
    readonly values: TargetRow & { readonly record_ordinal: number }
  }[]
  readonly bytes: Uint8Array
} {
  const contract = ctx.preflight.contract!.digest
  const identity = { sourceGeneration: ctx.sourceGenerationId, sourceContract: contract, table }
  const id = ctx.ids.child(
    'code-history',
    encodeMigrationKey(
      'code-history-package',
      [ctx.sourceGenerationId, contract, table].map(canonicalValue),
    ),
  )
  const ordered = [...rows].sort((a, b) =>
    a.encodedKey < b.encodedKey ? -1 : a.encodedKey > b.encodedKey ? 1 : 0,
  )
  const bytes = encodeHistoryPackage({ ...identity, rows: ordered })
  const content = encodeContentRefColumns(
    legacyLocationToContentRef({
      location: { codec: 'code-history@1', value: identity },
      kind: 'inline',
      bytes,
    }),
  )
  return {
    bytes,
    archive: {
      id,
      format_version: 1,
      source_contract: contract,
      source_generation: ctx.sourceGenerationId,
      source_table: table,
      row_count: rows.length,
      root_digest: bytesDigest(bytes),
      created_at: ctx.planTime,
      content_ref_json: content.json,
      content_inline_bytes: content.inlineBytes,
    },
    index: ordered.map((row, recordOrdinal) => ({
      row,
      values: {
        source_table: table,
        original_id:
          row.key.length === 1 && row.key[0]!.type === 'text' ? row.key[0]!.value : row.encodedKey,
        source_contract: contract,
        archive_id: id,
        original_key_json: canonicalSchemaJson(row.key),
        record_ordinal: recordOrdinal,
      },
    })),
  }
}
