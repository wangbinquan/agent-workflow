import type { ConversionRule, RuleContext } from '../rule'
import type { SourceRow, TargetRow } from '../types'
import { requiredSeeds, checkSeedPresence, seedPresence } from './seedPresence'
import { genericIdentities, identityMaxima, recordIdentityHighWater } from './identityHighWater'

/** Source and target column order are independent; missing/extra columns still reach codec validation. */
export function valuesByColumnName(row: SourceRow, ctx: RuleContext): TargetRow {
  const names = Object.values(ctx.target.table(row.table).columns).map((column) => column.name)
  return Object.fromEntries(
    [...names, ...Object.keys(row.values).filter((name) => !names.includes(name))]
      .filter((name) => Object.hasOwn(row.values, name))
      .map((name) => [name, row.values[name]!]),
  )
}

export function preservedRule(table: string): ConversionRule {
  return {
    ref: { id: `generic/preserve/${table}`, version: 1 },
    owner: 'persistence-migration',
    claims: [table],
    produces: [{ table }],
    lookups: [
      ...(requiredSeeds.some((seed) => seed.table === table) ? [seedPresence.key] : []),
      ...(genericIdentities.some((identity) => identity.table === table)
        ? [identityMaxima.key]
        : []),
    ],
    unit: { kind: 'source-chunk', table },
    disposition: 'preserved',
    convert(unit, ctx) {
      checkSeedPresence(table, ctx)
      recordIdentityHighWater(table, ctx)
      for (const row of unit.rows.get(table) ?? [])
        ctx.out.row(table, valuesByColumnName(row, ctx), row)
    },
  }
}
