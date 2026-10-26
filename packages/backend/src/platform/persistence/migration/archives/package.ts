import { canonicalSchemaJson } from '../../schema/canonical'
import { legacyLocationToContentRef } from '../conversion/content'
import { encodeContentRefColumns } from '@/platform/content/contentRefCodec'
import { bytesDigest } from '../conversion/digest'
import { canonicalValue, encodeMigrationKey } from '../conversion/migrationKey'
import type { RuleContext } from '../conversion/rule'
import type { SourceRow, TargetRow } from '../conversion/types'

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
