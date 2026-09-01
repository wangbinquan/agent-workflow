import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { capabilityTemplates } from '@/db/schema'
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

export function createSqliteCapabilityTemplatePersistence(
  db: DbClient,
): CapabilityTemplatePersistence {
  return {
    async list() {
      return (await db.select().from(capabilityTemplates)).map(record)
    },
    async load(id) {
      const rows = await db
        .select()
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, id))
        .limit(1)
      return rows[0] === undefined ? null : record(rows[0])
    },
    async ownerNameExists(input) {
      const rows = await db
        .select({ id: capabilityTemplates.id, ownerUserId: capabilityTemplates.ownerUserId })
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.name, input.name))
      return rows.some((row) => row.ownerUserId === input.ownerUserId && row.id !== input.excludeId)
    },
    async insert(row) {
      try {
        await db.insert(capabilityTemplates).values(row)
      } catch (error) {
        uniqueGuard(error, row.name)
      }
    },
    async replace(row) {
      try {
        await db.update(capabilityTemplates).set(row).where(eq(capabilityTemplates.id, row.id))
      } catch (error) {
        uniqueGuard(error, row.name)
      }
    },
    async delete(id) {
      await db.delete(capabilityTemplates).where(eq(capabilityTemplates.id, id))
    },
  }
}
