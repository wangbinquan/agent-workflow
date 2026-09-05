// RFC-359 W4-B5 —— 评审人槽位解析的读取面：一份实现，两个 provider 共用。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, capabilityTemplates, repoCapabilityConfig } from '@/db/schema'
import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import type { ReviewerResolutionRead } from '../application/ports/reviewerResolutionRead'

export class DrizzleReviewerResolutionRead implements ReviewerResolutionRead {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async loadRepositoryCapability(input: {
    readonly repositoryId: string
    readonly capability: string
  }) {
    const rows = await this.db
      .select({ templateId: repoCapabilityConfig.templateId })
      .from(repoCapabilityConfig)
      .where(
        and(
          eq(repoCapabilityConfig.repoId, input.repositoryId),
          eq(repoCapabilityConfig.capability, input.capability),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }

  async loadTemplate(templateId: string) {
    const rows = await this.db
      .select({ agentBySlotJson: capabilityTemplates.agentBySlotJson })
      .from(capabilityTemplates)
      .where(eq(capabilityTemplates.id, templateId))
      .limit(1)
    return rows[0] ?? null
  }

  async loadAgent(agentId: string) {
    const rows = await this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1)
    return rows[0] === undefined ? null : rowToAgent(rows[0])
  }
}
