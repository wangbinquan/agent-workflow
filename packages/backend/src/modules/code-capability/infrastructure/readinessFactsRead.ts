// RFC-359 W4-B5 —— 就绪度事实读取：一份实现，两个 provider 共用。

import { and, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { agents, capabilityTemplates, webhookTriggers } from '@/db/schema'
import type { ReadinessFactsReadPort } from '../application/ports/readinessFactsRead'
import { createRepoEndpointRead } from './repoEndpointRead'

function mappedAgentId(raw: string, slot: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return null
    const value = (parsed as Readonly<Record<string, unknown>>)[slot]
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

export function createReadinessFactsRead(db: ProviderNeutralDatabase): ReadinessFactsReadPort {
  return {
    repoEndpoints: createRepoEndpointRead(db),
    async templateExists(templateId) {
      const row = await db
        .select({ id: capabilityTemplates.id })
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, templateId))
        .limit(1)
      return row.length === 1
    },
    async listCapabilityTriggers(input) {
      return await db
        .select({
          id: webhookTriggers.id,
          repoScope: webhookTriggers.repoScope,
          eventTypes: webhookTriggers.eventTypes,
        })
        .from(webhookTriggers)
        .where(
          and(
            eq(webhookTriggers.endpointId, input.endpointId),
            eq(webhookTriggers.launchKind, 'code-round'),
            eq(webhookTriggers.launchRefId, input.capability),
          ),
        )
    },
    async agentSlotVisible(input) {
      const [template] = await db
        .select({ agentBySlotJson: capabilityTemplates.agentBySlotJson })
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, input.templateId))
        .limit(1)
      if (template === undefined) return false
      const agentId = mappedAgentId(template.agentBySlotJson, input.slot)
      if (agentId === null) return false
      const existing = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1)
      return existing.length === 1
    },
  }
}
