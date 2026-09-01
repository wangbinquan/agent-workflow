// RFC-349 — PostgreSQL facts for the provider-neutral readiness use case.

import { and, eq } from 'drizzle-orm'
import { agents, capabilityTemplates, webhookTriggers } from '@/db/schema'
import type { ReadinessFactsReadPort } from '../application/ports/readinessFactsRead'
import { createPostgresqlRepoEndpointRead } from './postgresqlRepoEndpointRead'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

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

export function createPostgresqlReadinessFactsRead(
  db: PostgresqlDatabaseClient,
): ReadinessFactsReadPort {
  return {
    repoEndpoints: createPostgresqlRepoEndpointRead(db),
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
