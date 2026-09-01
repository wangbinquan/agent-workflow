// RFC-349 — PostgreSQL facts for the repository capability matrix.
//
// This adapter batches the bounded matrix read into a constant number of SQL
// statements. It deliberately returns facts, not a readiness verdict: the
// application remains the only owner of deriveReadiness and repair actions.

import { and, eq, inArray } from 'drizzle-orm'

import { agents, capabilityTemplates, repoCapabilityConfig, webhookTriggers } from '@/db/schema'
import type {
  CapabilityMatrixReadPort,
  CapabilityMatrixReadRow,
} from '@/modules/code-capability/application/ports/capabilityMatrixRead'
import {
  capabilityAgentSlots,
  capabilityRequiresWakeSource,
  selectCapabilityTrigger,
} from '@/modules/code-capability/application/readinessFacts'
import { resolveRepoEndpoint } from '@/modules/code-capability/application/resolveRepoEndpoint'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { createPostgresqlRepoEndpointRead } from './postgresqlRepoEndpointRead'

function parseStringMap(raw: string): Readonly<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Readonly<Record<string, unknown>>)
      : {}
  } catch {
    return {}
  }
}

export function createPostgresqlCapabilityMatrixRead(
  db: PostgresqlDatabaseClient,
): CapabilityMatrixReadPort {
  const endpointReader = createPostgresqlRepoEndpointRead(db)
  return {
    async loadForRepo(repoId) {
      const cells = await db
        .select({
          repoId: repoCapabilityConfig.repoId,
          capability: repoCapabilityConfig.capability,
          templateId: repoCapabilityConfig.templateId,
          enabled: repoCapabilityConfig.enabled,
        })
        .from(repoCapabilityConfig)
        .where(eq(repoCapabilityConfig.repoId, repoId))
      if (cells.length === 0) return []

      const endpoint = await resolveRepoEndpoint(endpointReader, repoId)

      const templateIds = [
        ...new Set(
          cells
            .map((cell) => cell.templateId)
            .filter((templateId): templateId is string => templateId !== null && templateId !== ''),
        ),
      ]
      const templates =
        templateIds.length === 0
          ? []
          : await db
              .select({
                id: capabilityTemplates.id,
                agentBySlotJson: capabilityTemplates.agentBySlotJson,
              })
              .from(capabilityTemplates)
              .where(inArray(capabilityTemplates.id, templateIds))
      const templatesById = new Map(templates.map((template) => [template.id, template]))

      const triggers = endpoint.ok
        ? await db
            .select({
              id: webhookTriggers.id,
              launchRefId: webhookTriggers.launchRefId,
              repoScope: webhookTriggers.repoScope,
              eventTypes: webhookTriggers.eventTypes,
            })
            .from(webhookTriggers)
            .where(
              and(
                eq(webhookTriggers.endpointId, endpoint.endpointId),
                eq(webhookTriggers.launchKind, 'code-round'),
              ),
            )
        : []

      const agentIds = new Set<string>()
      for (const cell of cells) {
        if (cell.templateId === null || cell.templateId === '') continue
        const template = templatesById.get(cell.templateId)
        if (template === undefined) continue
        const bySlot = parseStringMap(template.agentBySlotJson)
        for (const slot of capabilityAgentSlots(cell.capability)) {
          const agentId = bySlot[slot]
          if (typeof agentId === 'string' && agentId !== '') agentIds.add(agentId)
        }
      }
      const existingAgentIds =
        agentIds.size === 0
          ? new Set<string>()
          : new Set(
              (
                await db
                  .select({ id: agents.id })
                  .from(agents)
                  .where(inArray(agents.id, [...agentIds]))
              ).map((agent) => agent.id),
            )

      return cells.map((cell): CapabilityMatrixReadRow => {
        const hasBinding = cell.templateId !== null && cell.templateId !== ''
        const template = hasBinding ? templatesById.get(cell.templateId as string) : undefined
        const bySlot = template === undefined ? {} : parseStringMap(template.agentBySlotJson)
        const invisibleAgentSlots = capabilityAgentSlots(cell.capability).filter((slot) => {
          if (!hasBinding) return true
          const agentId = bySlot[slot]
          return typeof agentId !== 'string' || agentId === '' || !existingAgentIds.has(agentId)
        })
        const trigger = selectCapabilityTrigger(
          triggers.filter((candidate) => candidate.launchRefId === cell.capability),
          repoId,
        )
        return {
          repoId: cell.repoId,
          capability: cell.capability,
          templateId: cell.templateId,
          enabled: cell.enabled,
          facts: {
            enabled: cell.enabled,
            hasBinding,
            frameworkExists: template !== undefined,
            hasTrigger: trigger !== null,
            codeHostConfigured: endpoint.ok,
            invisibleAgentSlots,
            requiresWakeSource: capabilityRequiresWakeSource(cell.capability),
            hasWakeSource: (trigger?.events ?? []).some((event) => event.startsWith('pipeline_')),
          },
        }
      })
    },
  }
}
