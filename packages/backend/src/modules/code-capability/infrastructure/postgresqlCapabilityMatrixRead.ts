// RFC-349 — PostgreSQL facts for the repository capability matrix.
//
// This adapter batches the bounded matrix read into a constant number of SQL
// statements. It deliberately returns facts, not a readiness verdict: the
// application remains the only owner of deriveReadiness and repair actions.

import { and, eq, inArray } from 'drizzle-orm'

import {
  agents,
  cachedRepos,
  capabilityTemplates,
  codeHostConnections,
  repoCapabilityConfig,
  webhookEndpoints,
  webhookTriggers,
} from '@/db/schema'
import type {
  CapabilityMatrixReadPort,
  CapabilityMatrixReadRow,
} from '@/modules/code-capability/application/ports/capabilityMatrixRead'
import {
  capabilityAgentSlots,
  capabilityRequiresWakeSource,
  selectCapabilityTrigger,
} from '@/modules/code-capability/application/readinessFacts'
import type { RepoEndpointVerdict } from '@/modules/code-capability/application/resolveRepoEndpoint'
import {
  resolveRepoProvider,
  type ConnectionCandidate,
} from '@/modules/code-capability/domain/repoProvider'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

type CodeHostProvider = 'gitlab' | 'github'

interface EnabledEndpoint {
  readonly id: string
  readonly provider: CodeHostProvider
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

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

async function resolveEndpoint(
  db: PostgresqlDatabaseClient,
  repoId: string,
  endpoints: readonly EnabledEndpoint[],
): Promise<RepoEndpointVerdict> {
  if (endpoints.length === 0) {
    return {
      ok: false,
      message:
        'no enabled webhook endpoint is configured, so this repository has no identity to key its findings to',
    }
  }

  const providers = [...new Set(endpoints.map((row) => row.provider))]
  let provider: CodeHostProvider
  if (providers.length === 1) {
    provider = providers[0]!
  } else {
    const [repo] = await db
      .select({ urlRedacted: cachedRepos.urlRedacted })
      .from(cachedRepos)
      .where(eq(cachedRepos.id, repoId))
      .limit(1)
    const rows = await db
      .select({
        provider: codeHostConnections.provider,
        baseUrl: codeHostConnections.baseUrl,
        prefixes: codeHostConnections.repositoryUrlPrefixesJson,
      })
      .from(codeHostConnections)
    const candidates: ConnectionCandidate[] = rows
      .filter((row) => providers.includes(row.provider))
      .map((row) => ({
        provider: row.provider,
        baseUrl: row.baseUrl,
        repositoryUrlPrefixes: parseStringArray(row.prefixes),
      }))
    const verdict = resolveRepoProvider(repo?.urlRedacted ?? null, candidates)
    if (!verdict.ok) return verdict
    provider = verdict.provider
  }

  const matches = endpoints.filter((row) => row.provider === provider)
  if (matches.length !== 1) {
    return {
      ok: false,
      message: `${String(matches.length)} enabled ${provider} webhook endpoints exist and this repository does not record which one delivers its events — pick one explicitly rather than keying its ledger to an arbitrary endpoint`,
    }
  }
  return { ok: true, provider, endpointId: matches[0]!.id }
}

export function createPostgresqlCapabilityMatrixRead(
  db: PostgresqlDatabaseClient,
): CapabilityMatrixReadPort {
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

      const endpoints = await db
        .select({ id: webhookEndpoints.id, provider: webhookEndpoints.provider })
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.enabled, true))
      const endpoint = await resolveEndpoint(db, repoId, endpoints)

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
        const provider = endpoint.ok ? endpoint.provider : 'gitlab'
        const codeHostConfigured =
          endpoints.filter((candidate) => candidate.provider === provider).length === 1

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
            codeHostConfigured,
            invisibleAgentSlots,
            requiresWakeSource: capabilityRequiresWakeSource(cell.capability),
            hasWakeSource: (trigger?.events ?? []).some((event) => event.startsWith('pipeline_')),
          },
        }
      })
    },
  }
}
