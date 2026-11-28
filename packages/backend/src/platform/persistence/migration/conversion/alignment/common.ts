import { rowBlock } from '../blockCodes'
import { canonicalValue } from '../migrationKey'
import type { LookupKey } from '../lookups'
import type { ConversionRule, ReferenceKeepPolicy, RuleContext } from '../rule'
import type { JsonValue, SourceRow, TargetRow, TargetValue } from '../types'
import { valuesByColumnName, preservedRule } from '../generic/preserved'
import { checkSeedPresence } from '../generic/seedPresence'
import { recordIdentityHighWater } from '../generic/identityHighWater'
import { alignmentReferencePolicies } from './referencePolicies'

/** RFC-626 §3.4 rows 11 / 11b: a row kept with its dangling reference cleared or re-pointed. */
export const DANGLING_REFERENCE_KEPT = 'v2-dangling-reference-kept'

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

/**
 * The keep policy of the single-column foreign key behind `column`, exactly as the target
 * finalize resolves it (`target/dangling.ts`): the declared entry of
 * `alignmentReferencePolicies`, otherwise detach when the target declares `set null`.
 */
function keepPolicyOf(
  table: string,
  column: string,
  ctx: RuleContext,
): { readonly foreignKey: string; readonly action: ReferenceKeepPolicy['action'] } | null {
  const foreignKey = ctx.target
    .table(table)
    .foreignKeys.find((entry) => entry.columns.length === 1 && entry.columns[0] === column)
  if (!foreignKey) return null
  const action =
    alignmentReferencePolicies.find(
      (policy) => policy.table === table && policy.foreignKey === foreignKey.name,
    )?.action ?? (foreignKey.onDelete === 'set null' ? ({ kind: 'detach' } as const) : null)
  return action ? { foreignKey: foreignKey.name, action } : null
}

/**
 * A reference whose row is not in the source. Operator resolution blocks the referring row.
 * RFC-626 §3.3 / §3.4 rows 11–11b: with automatic resolution the row stays and only this
 * reference changes, by the keep policy the target finalize applies to the same foreign key,
 * so the outcome does not depend on whether the referenced row was missing from the source or
 * set aside during the conversion. The original value is recorded with the decision.
 */
export function resolveDanglingReference(row: SourceRow, column: string, ctx: RuleContext): void {
  const policy = ctx.resolution === 'automatic' ? keepPolicyOf(row.table, column, ctx) : null
  if (!policy) {
    blockDanglingReference(row, column, ctx)
    return
  }
  const replaced: Readonly<Record<string, TargetValue>> =
    policy.action.kind === 'detach' ? { [column]: null } : policy.action.values
  const detail = {
    column,
    foreignKey: policy.foreignKey,
    action: policy.action.kind === 'detach' ? 'detached' : 'substituted',
    previous: Object.fromEntries(
      Object.keys(replaced).map((name) => [name, canonicalValue(row.values[name] ?? null)]),
    ),
    values: Object.fromEntries(
      Object.entries(replaced).map(([name, value]) => [name, canonicalValue(value)]),
    ),
  }
  // Recorded first: the decision names the row before the row's own outputs classify it.
  ctx.out.record(
    {
      kind: 'decision',
      code: DANGLING_REFERENCE_KEPT,
      payload: { automatic: 'kept', sourceTable: row.table, sourceKey: row.encodedKey, ...detail },
    },
    row,
  )
  resolveAlignment(
    row,
    { ...valuesByColumnName(row, ctx), ...replaced },
    DANGLING_REFERENCE_KEPT,
    detail,
    ctx,
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
