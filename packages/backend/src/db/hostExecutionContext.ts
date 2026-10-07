import { sql } from 'drizzle-orm'
import { check, integer, sqliteTable as physicalTable, text } from 'drizzle-orm/sqlite-core'
import { providerAwareSqliteTable } from './providerSchema'

const table = providerAwareSqliteTable(physicalTable)

/** One installation execution fact; Task ownership and effects remain Task-owned. */
export const hostExecutionWriteContexts = table(
  'system_host_execution_write_contexts',
  {
    id: text('id').primaryKey(),
    holder: text('holder').notNull(),
    generation: text('generation').notNull(),
    revision: integer('revision').notNull(),
    phase: text('phase', { enum: ['preparing', 'active', 'draining', 'closed'] }).notNull(),
    expiresAt: integer('expires_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    check('host_execution_write_singleton_ck', sql`${t.id} = 'installation'`),
    check('host_execution_write_revision_ck', sql`${t.revision} > 0`),
    check(
      'host_execution_write_phase_ck',
      sql`${t.phase} IN ('preparing','active','draining','closed')`,
    ),
  ],
)
