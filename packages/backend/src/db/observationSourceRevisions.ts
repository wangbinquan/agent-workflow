import { sqliteTable as physicalTable, text } from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable, withObservationSourceRevision } from './providerSchema'
import { OBSERVATION_SOURCE_REVISION } from '@/platform/persistence/observationSourceRevisionSchema'

const table = providerAwareSqliteTable(physicalTable)
/** Actual source transaction identities; report and derived cache writes never update them. */
export const observationSourceRevisions = withObservationSourceRevision(
  table('observation_source_revisions', {
    sourceId: text('source_id').primaryKey(),
    revision: text('revision').notNull(),
  }),
  OBSERVATION_SOURCE_REVISION,
)
