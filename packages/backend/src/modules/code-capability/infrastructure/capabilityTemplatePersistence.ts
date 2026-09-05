// RFC-359 W4-B5 —— 能力模板持久化：一份实现，两个 provider 共用。名字撞库经引擎能力矩阵归类。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { capabilityTemplates } from '@/db/schema'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { ConflictError } from '@/util/errors'
import type {
  CapabilityTemplatePersistence,
  CapabilityTemplateRecord,
} from '../application/ports/capabilityTemplatePersistence'

function record(row: typeof capabilityTemplates.$inferSelect): CapabilityTemplateRecord {
  return row
}

export function createCapabilityTemplatePersistence(
  db: ProviderNeutralDatabase,
): CapabilityTemplatePersistence {
  const uniqueGuard = (error: unknown, name: string): never => {
    if (engineOf(db).classifyError(error) === 'unique-violation') {
      throw new ConflictError(
        'capability-template-name-taken',
        `you already have one named '${name}'`,
      )
    }
    throw error
  }
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
