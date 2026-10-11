import {
  check,
  index,
  primaryKey,
  sqliteTable as physicalTable,
  text,
} from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(physicalTable)

/** Rebuildable original numeric pages; these are never accepted usage or cost authorities. */
export const observationNativeFactRoots = table(
  'observation_native_fact_roots',
  {
    cacheKey: text('cache_key').primaryKey(),
    proofKey: text('proof_key').notNull(),
    rootSessionId: text('root_session_id').notNull(),
    state: text('state', { enum: ['sealed'] }).notNull(),
    document: text('document').notNull(), // Complete root identity, proof, page count and original EOF.
  },
  (t) => [
    index('observation_native_fact_epoch_idx').on(t.proofKey, t.cacheKey),
    check('observation_native_fact_state_ck', sql`${t.state} = 'sealed'`),
  ],
)

export const observationNativeFactPages = table(
  'observation_native_fact_pages',
  {
    cacheKey: text('cache_key')
      .notNull()
      .references(() => observationNativeFactRoots.cacheKey, { onDelete: 'cascade' }),
    cursor: text('cursor').notNull(),
    document: text('document').notNull(), // Exact original HistoricalNativeObservationPage JSON.
  },
  (t) => [primaryKey({ columns: [t.cacheKey, t.cursor] })],
)
