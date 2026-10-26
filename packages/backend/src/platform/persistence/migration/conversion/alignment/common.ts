import { rowBlock } from '../blockCodes'
import { canonicalValue } from '../migrationKey'
import type { LookupKey } from '../lookups'
import type { ConversionRule, RuleContext } from '../rule'
import type { JsonValue, SourceRow, TargetRow } from '../types'
import { valuesByColumnName, preservedRule } from '../generic/preserved'
import { checkSeedPresence } from '../generic/seedPresence'
import { recordIdentityHighWater } from '../generic/identityHighWater'

export function alignmentRule(
  table: string,
  lookups: readonly LookupKey<unknown>[],
  convert: (row: SourceRow, ctx: RuleContext) => void,
): ConversionRule {
  const base = preservedRule(table)
  return {
    ...base,
    ref: { id: `alignment/${table}`, version: 1 },
    lookups: [...new Map([...base.lookups, ...lookups].map((key) => [key.id, key])).values()],
    convert(unit, ctx) {
      checkSeedPresence(table, ctx)
      recordIdentityHighWater(table, ctx)
      for (const row of unit.rows.get(table) ?? []) convert(row, ctx)
    },
  }
}

export function danglingReference(
  row: SourceRow,
  column: string,
  ids: LookupKey<true>,
  ctx: RuleContext,
): boolean {
  const value = row.values[column]
  return typeof value === 'string' && !ctx.lookup(ids).get(value)
}

export function blockDanglingReference(row: SourceRow, column: string, ctx: RuleContext): void {
  ctx.out.block(
    rowBlock(
      'v2-dangling-reference',
      row,
      {
        column,
        value: canonicalValue(row.values[column]!),
        source: row.canonical,
      },
      [column],
    ),
  )
}

export function copyAlignedRow(row: SourceRow, ctx: RuleContext): void {
  ctx.out.row(row.table, valuesByColumnName(row, ctx), row)
}

export function resolveAlignment(
  row: SourceRow,
  values: TargetRow,
  code: string,
  detail: JsonValue,
  ctx: RuleContext,
): void {
  ctx.out.row(row.table, values, row)
  ctx.out.exception({
    sourceTable: row.table,
    sourceKey: row.encodedKey,
    class: 'converted',
    kind: 'conflict-resolved',
    targets: [{ table: row.table, key: ctx.target.key(row.table, values) }],
    archive: null,
    decision: { code, detail },
  })
}
