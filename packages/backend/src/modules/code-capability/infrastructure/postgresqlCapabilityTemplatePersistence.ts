import { eq } from 'drizzle-orm'

import { capabilityTemplates } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError } from '@/util/errors'
import type {
  CapabilityTemplatePersistence,
  CapabilityTemplateRecord,
} from '../application/ports/capabilityTemplatePersistence'

function record(row: typeof capabilityTemplates.$inferSelect): CapabilityTemplateRecord {
  return row
}

function uniqueGuard(error: unknown, name: string): never {
  const detail = error instanceof Error ? error.message : String(error)
  if (detail.toLowerCase().includes('unique')) {
    throw new ConflictError(
      'capability-template-name-taken',
      `you already have one named '${name}'`,
    )
  }
  throw error
}

export function createPostgresqlCapabilityTemplatePersistence(
  db: PostgresqlDatabaseClient,
): CapabilityTemplatePersistence {
  return {
    async list() {
      return (await db.select().from(capabilityTemplates).all()).map(record)
    },
    async load(id) {
      const row = await db
        .select()
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, id))
        .limit(1)
        .get()
      return row === undefined ? null : record(row)
    },
    async ownerNameExists(input) {
      const rows = await db
        .select({ id: capabilityTemplates.id, ownerUserId: capabilityTemplates.ownerUserId })
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.name, input.name))
        .all()
      return rows.some((row) => row.ownerUserId === input.ownerUserId && row.id !== input.excludeId)
    },
    async insert(row) {
      try {
        await db.insert(capabilityTemplates).values(row).run()
      } catch (error) {
        uniqueGuard(error, row.name)
      }
    },
    async replace(row) {
      try {
        await db
          .update(capabilityTemplates)
          .set(row)
          .where(eq(capabilityTemplates.id, row.id))
          .run()
      } catch (error) {
        uniqueGuard(error, row.name)
      }
    },
    async delete(id) {
      await db.delete(capabilityTemplates).where(eq(capabilityTemplates.id, id)).run()
    },
  }
}
