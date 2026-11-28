import { lookupKey, type LookupBuilder } from '../lookups'
import type { RuleContext } from '../rule'
import type { MigrationRecord } from '../types'

export const genericIdentities = [
  { table: 'intent_turn_events', column: 'id' },
  { table: 'memory_distill_events', column: 'id' },
  { table: 'mcp_runtime_test_events', column: 'id' },
  { table: 'hosted_execution_events', column: 'id' },
  { table: 'node_run_events', column: 'id' },
] as const

export const identityMaxima: LookupBuilder<{ readonly maximum: string | null }> = {
  key: lookupKey('generic/identity-maxima', 1),
  sources: genericIdentities.map(({ table }) => table),
  build(staged, put) {
    for (const { table, column } of genericIdentities) {
      let maximum: bigint | null = null
      for (const row of staged.rows(table)) {
        const value = row.values[column]
        // An unsafe integer still contributes to evidence; target codecs block its row.
        if (
          typeof value !== 'bigint' &&
          !(typeof value === 'number' && Number.isSafeInteger(value))
        )
          continue
        const integer = BigInt(value)
        if (maximum === null || integer > maximum) maximum = integer
      }
      put(table, { maximum: maximum === null ? null : String(maximum) })
    }
  },
}

export function identityHighWaterRecord(
  table: string,
  column: string,
  maximum: string | null,
  ctx: Pick<RuleContext, 'preflight' | 'preUpgradePreflight'>,
  sequenceValue?: string,
): Extract<MigrationRecord, { kind: 'identity-high-water' }> {
  const original = ctx.preUpgradePreflight ?? ctx.preflight
  // A recorded sequence value that is not an integer is left out instead of failing the whole
  // conversion on `BigInt`: the row that carries it is blocked (or, with automatic resolution,
  // set aside) by the metadata rule, and the high water then rests on the rows themselves.
  const integer = (value: unknown): bigint[] =>
    /^-?\d+$/.test(String(value)) ? [BigInt(String(value))] : []
  const sequences = original.identityHighWater
    .filter((entry) => entry.table === table && (entry.column === column || entry.column === null))
    .flatMap((entry) => integer(entry.value))
  if (sequenceValue !== undefined) sequences.push(...integer(sequenceValue))
  const rowMaximum = maximum === null ? null : BigInt(maximum)
  const values = [...sequences, ...(rowMaximum === null ? [] : [rowMaximum])]
  const value = values.length ? values.reduce((a, b) => (a > b ? a : b)) : 0n
  return {
    kind: 'identity-high-water',
    table,
    column,
    value: String(value),
    basis: sequences.length ? (rowMaximum === null ? 'sequence' : 'both') : 'max-row',
    ...(original.identityEvidence === 'not-recorded-by-epoch1-artifact' && !sequences.length
      ? { warning: 'source-sequence-not-recorded; maximum-observed-only' }
      : {}),
  }
}

export function recordIdentityHighWater(table: string, ctx: RuleContext): void {
  const identity = genericIdentities.find((entry) => entry.table === table)
  if (!identity) return
  // Every unit carries the same full-table watermark, including units containing only blocked rows.
  // V3 folds identity records by (table, column) using max, never last-write-wins.
  ctx.out.record(
    identityHighWaterRecord(
      table,
      identity.column,
      ctx.lookup(identityMaxima.key).require(table).maximum,
      ctx,
    ),
  )
}
