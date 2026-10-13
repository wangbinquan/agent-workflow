import {
  index,
  integer,
  primaryKey,
  text,
  uniqueIndex,
  sqliteTable as physicalTable,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'
const table = providerAwareSqliteTable(physicalTable)
/** Only rebuildable views have expiry. Usage, source evidence and accepted prices do not. */
export const observationReportLeases = table(
  'observation_report_leases',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(),
    requestKey: text('request_key'),
    revision: text('revision'),
    expiresAt: integer('expires_at').notNull(),
    retiring: integer('retiring', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('observation_report_lease_request').on(t.requestKey),
    index('observation_report_lease_expiry').on(t.retiring, t.expiresAt),
  ],
)
export const observationScopeRefs = table(
  'observation_scope_refs',
  {
    viewId: text('view_id').notNull(),
    scope: text('scope').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.viewId, t.scope] }),
    index('observation_scope_reference').on(t.scope),
  ],
)
export const observationStorageState = table('observation_storage_state', {
  key: text('key').primaryKey(),
  document: text('document').notNull(),
})
export const observationStorageSamples = table('observation_storage_samples', {
  day: text('day').primaryKey(),
  sampledAt: integer('sampled_at').notNull(),
  document: text('document').notNull(),
})

export const observationWorkRetention = table('observation_work_retention', {
  id: text('id').primaryKey(),
  revision: text('revision'),
  queuedAt: integer('queued_at').notNull().default(0),
})
