import type { RuleContext } from '../rule'
import { lookupKey, type LookupBuilder } from '../lookups'

export const requiredSeeds = [
  { table: 'users', id: '__system__' },
  { table: 'auth_login_policy', id: 'global' },
] as const

export const seedPresence: LookupBuilder<true> = {
  key: lookupKey('generic/seed-presence', 1),
  sources: requiredSeeds.map((seed) => seed.table),
  build(staged, put) {
    for (const seed of requiredSeeds)
      for (const row of staged.rows(seed.table))
        if (row.values.id === seed.id) {
          put(JSON.stringify([seed.table, seed.id]), true)
          break
        }
  },
}

export function checkSeedPresence(table: string, ctx: RuleContext): void {
  for (const seed of requiredSeeds)
    if (seed.table === table && !ctx.lookup(seedPresence.key).get(JSON.stringify([table, seed.id])))
      ctx.out.block({
        code: 'v2-required-seed-missing',
        scope: 'table',
        sourceTable: table,
        sourceKey: null,
        taskId: null,
        runId: null,
        missingFields: ['id'],
        detail: { id: seed.id },
      })
}
