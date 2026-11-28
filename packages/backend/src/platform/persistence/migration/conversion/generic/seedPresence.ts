import type { RuleContext } from '../rule'
import { lookupKey, type LookupBuilder } from '../lookups'
import { decodeMigrationKey } from '../migrationKey'
import { decodeLogicalValue } from '../../legacy/logicalDatabaseArtifact'
import type { JsonValue } from '../types'

/**
 * Source tables that hold the rows every release depends on — the seeds the target schema
 * declares (RFC-626 §3.3: the same list target validation checks, not a shorter one). Which
 * rows those are comes from the target, `ctx.target.seedKeys`; only the table names are
 * listed here, because a lookup declares its sources up front. A guard test keeps this list
 * equal to the tables the schema seeds.
 */
export const requiredSeedTables: readonly string[] = [
  'users',
  'auth_login_policy',
  'committed_event_family_cutovers',
]

export const seedPresence: LookupBuilder<true> = {
  key: lookupKey('generic/seed-presence', 2),
  sources: requiredSeedTables,
  build(staged, put) {
    for (const table of requiredSeedTables)
      for (const row of staged.rows(table)) put(row.encodedKey, true)
  },
}

/** A seed row keeps its table name and key from the source to the target. */
export function checkSeedPresence(table: string, ctx: RuleContext): void {
  for (const key of ctx.target.seedKeys(table)) {
    if (ctx.lookup(seedPresence.key).get(key)) continue
    const names = ctx.target.table(table).primaryKey
    const cells = decodeMigrationKey(key).key
    const detail: Record<string, JsonValue> = {}
    names.forEach((name, index) => {
      const value = decodeLogicalValue(cells[index]!)
      detail[name] =
        typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : value === null
            ? null
            : String(value)
    })
    ctx.out.block({
      code: 'v2-required-seed-missing',
      scope: 'table',
      sourceTable: table,
      sourceKey: null,
      taskId: null,
      runId: null,
      missingFields: [...names],
      detail,
    })
  }
}
