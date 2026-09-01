import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { agents, capabilityTemplates, repoCapabilityConfig } from '@/db/schema'
import { rowToAgent } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import type { ReviewerResolutionRead } from '../application/ports/reviewerResolutionRead'

export class SqliteReviewerResolutionRead implements ReviewerResolutionRead {
  constructor(private readonly db: DbClient) {}

  async loadRepositoryCapability(input: {
    readonly repositoryId: string
    readonly capability: string
  }) {
    return (
      this.db
        .select({ templateId: repoCapabilityConfig.templateId })
        .from(repoCapabilityConfig)
        .where(
          and(
            eq(repoCapabilityConfig.repoId, input.repositoryId),
            eq(repoCapabilityConfig.capability, input.capability),
          ),
        )
        .limit(1)
        .get() ?? null
    )
  }

  async loadTemplate(templateId: string) {
    return (
      this.db
        .select({ agentBySlotJson: capabilityTemplates.agentBySlotJson })
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, templateId))
        .limit(1)
        .get() ?? null
    )
  }

  async loadAgent(agentId: string) {
    const row = this.db.select().from(agents).where(eq(agents.id, agentId)).limit(1).get()
    return row === undefined ? null : rowToAgent(row)
  }
}
