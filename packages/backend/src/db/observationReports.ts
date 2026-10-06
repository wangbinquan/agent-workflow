import { sql } from 'drizzle-orm'
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable as physicalTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable, withRetainedOutputRevision } from './providerSchema'
import { OBSERVATION_RETAINED_OUTPUT_REVISION } from '@/platform/persistence/retainedOutputRevisionSchema'
const table = providerAwareSqliteTable(physicalTable)
/** Rebuildable derived report cache; none of these relations is a usage, capture or price authority. */
export const observationReports = table(
  'observation_reports',
  {
    id: text('id').primaryKey(),
    requestKey: text('request_key').notNull(),
    generation: text('generation').notNull(),
    owner: text('owner').notNull(),
    actorScope: text('actor_scope').notNull(),
    request: text('request').notNull(),
    state: text('state', { enum: ['building', 'not-ready', 'failed', 'ready'] }).notNull(),
    report: text('report').notNull(),
    manifest: text('manifest'),
    progress: text('progress').notNull(),
    leaseUntil: integer('lease_until').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('observation_report_request_idx').on(t.requestKey),
    index('observation_report_recovery_idx').on(t.state, t.leaseUntil),
    check(
      'observation_report_state_ck',
      sql`${t.state} IN ('building','not-ready','failed','ready')`,
    ),
  ],
)
export const observationReportPages = table(
  'observation_report_pages',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => observationReports.id, { onDelete: 'cascade' }),
    ordinal: text('ordinal').notNull(),
    previousDigest: text('previous_digest').notNull(),
    digest: text('digest').notNull(),
    itemsCount: integer('items_count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.ordinal] }),
    check('observation_report_page_size_ck', sql`${t.itemsCount} BETWEEN 1 AND 500`),
  ],
)
export const observationReportRows = table(
  'observation_report_rows',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => observationReports.id, { onDelete: 'cascade' }),
    ordinal: text('ordinal').notNull(),
    section: text('section').notNull(),
    parent: text('parent').notNull(),
    key: text('key').notNull(),
    document: text('document').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.reportId, t.ordinal] }),
    uniqueIndex('observation_report_row_identity_idx').on(t.reportId, t.section, t.parent, t.key),
    index('observation_report_row_page_idx').on(t.reportId, t.section, t.parent, t.ordinal),
  ],
)
export const observationReportCounts = table(
  'observation_report_counts',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => observationReports.id, { onDelete: 'cascade' }),
    section: text('section').notNull(),
    parent: text('parent').notNull(),
    total: text('total').notNull().default('0'),
    actual: text('actual').notNull().default('0'),
    declared: integer('declared', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.section, t.parent] })],
)
export const observationReportReceipts = table(
  'observation_report_receipts',
  {
    reportId: text('report_id')
      .notNull()
      .references(() => observationReports.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    document: text('document').notNull(),
  },
  (t) => [primaryKey({ columns: [t.reportId, t.key] })],
)
export const observationReportRetainedRevisions = withRetainedOutputRevision(
  table('observation_report_retained_revisions', {
    reportId: text('report_id')
      .primaryKey()
      .references(() => observationReports.id, { onDelete: 'cascade' }),
    revision: text('revision').notNull(),
  }),
  OBSERVATION_RETAINED_OUTPUT_REVISION,
)
