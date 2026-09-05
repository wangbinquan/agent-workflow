// RFC-359 W4-B5 —— 仓库能力参数读取：一份实现，两个 provider 共用。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { capabilityTemplates, repoCapabilityConfig } from '@/db/schema'
import type { CapabilityParamRead } from '../application/ports/capabilityParamRead'

export function createCapabilityParamRead(db: ProviderNeutralDatabase): CapabilityParamRead {
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
