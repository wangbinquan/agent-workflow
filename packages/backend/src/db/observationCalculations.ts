import { primaryKey, sqliteTable as physicalTable, text } from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(physicalTable)
/** Rebuildable, atomically sealed calculation versions, independent of report retention. */
export const observationCalculationVersions = table('observation_calculation_versions', {
  cacheKey: text('cache_key').primaryKey(),
  sourceKey: text('source_key').notNull(),
  document: text('document').notNull(),
})
export const observationCalculationRows = table(
  'observation_calculation_rows',
  {
    cacheKey: text('cache_key')
      .notNull()
      .references(() => observationCalculationVersions.cacheKey, { onDelete: 'cascade' }),
    namespace: text('namespace').notNull(),
    key: text('key').notNull(),
    document: text('document').notNull(),
  },
  (t) => [primaryKey({ columns: [t.cacheKey, t.namespace, t.key] })],
)
