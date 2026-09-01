import { and, eq } from 'drizzle-orm'

import { capabilityTemplates, repoCapabilityConfig } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { CapabilityParamRead } from '../application/ports/capabilityParamRead'

export function createPostgresqlCapabilityParamRead(
  db: PostgresqlDatabaseClient,
): CapabilityParamRead {
  return {
    async find(input) {
      const rows = await db
        .select({
          paramSchemaJson: capabilityTemplates.paramSchemaJson,
          paramDefaultsJson: capabilityTemplates.paramDefaultsJson,
          paramsJson: capabilityTemplates.paramsJson,
        })
        .from(repoCapabilityConfig)
        .innerJoin(capabilityTemplates, eq(capabilityTemplates.id, repoCapabilityConfig.templateId))
        .where(
          and(
            eq(repoCapabilityConfig.repoId, input.repoId),
            eq(repoCapabilityConfig.capability, input.capability),
          ),
        )
        .limit(1)
      return rows[0] ?? null
    },
  }
}
