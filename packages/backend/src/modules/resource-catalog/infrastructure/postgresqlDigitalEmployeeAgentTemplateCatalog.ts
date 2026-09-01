import type { Agent, AgentSkillRef, CreateAgent } from '@agent-workflow/shared'
import { and, eq, inArray, ne } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { agents, mcps, plugins, runtimes, skills } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type {
  DigitalEmployeeAgentTemplateFence,
  DigitalEmployeeAgentTemplateRepository,
} from '../application/agents/digitalEmployeeAgentTemplateCatalog'
import { PLUGIN_DISABLED_ERROR_CODE } from '../public/types'
import {
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  updateAgentPersistenceValues,
} from './agentPersistence'
import {
  isPostgresqlUniqueViolation,
  runPostgresqlResourceCatalogTransaction,
  type PostgresqlResourceCatalogTransaction,
} from './postgresql/repositorySupport'

type AgentRow = typeof agents.$inferSelect

function occupied(id: string): ConflictError {
  return new ConflictError(
    'builtin-agent-id-collision',
    `stable digital employee Agent id '${id}' is occupied`,
  )
}

function nameConflict(name: string): ConflictError {
  return new ConflictError('agent-name-in-use', `agent '${name}' already exists`)
}

function stale(id: string): ConflictError {
  return staleConflictError('agent', `agent '${id}' changed; reload and retry`)
}

function requireSystemBuiltin(
  id: string,
  row: AgentRow | undefined,
  fence?: DigitalEmployeeAgentTemplateFence,
): Agent {
  if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
  if (row.ownerUserId !== SYSTEM_USER_ID || row.builtin !== true) throw occupied(id)
  if (
    fence !== undefined &&
    (row.updatedAt !== fence.expectedUpdatedAt || row.aclRevision !== fence.expectedAclRevision)
  ) {
    throw stale(id)
  }
  return agentFromPersistenceRow(row)
}

function assertBranchPortsDeclared(agent: Pick<CreateAgent, 'outputs' | 'branchPorts'>): void {
  if (agent.branchPorts === undefined || agent.branchPorts.length === 0) return
  const outputs = new Set(agent.outputs)
  const missing = agent.branchPorts.filter((port) => !outputs.has(port))
  if (missing.length === 0) return
  throw new ValidationError(
    'branch-port-not-declared',
    `agent branchPorts reference undeclared output port(s): ${missing.join(', ')}`,
    { notFound: missing },
  )
}

async function assertRuntimeReference(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly name: string | null | undefined
  readonly previous?: string
}): Promise<void> {
  if (input.name === null || input.name === undefined) return
  const row = await input.transaction
    .select({ name: runtimes.name, enabled: runtimes.enabled })
    .from(runtimes)
    .where(eq(runtimes.name, input.name))
    .get()
  if (row === undefined) {
    throw new ValidationError(
      'runtime-not-found',
      `agent references unknown runtime: ${input.name}`,
      { notFound: [input.name] },
    )
  }
  if (!row.enabled && input.name !== input.previous) {
    throw new ValidationError(
      'runtime-disabled',
      `agent references disabled runtime: ${input.name}; enable it or pick another`,
      { disabled: [input.name] },
    )
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

async function assertAgentResourceRows(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly mcpIds: readonly string[]
  readonly pluginIds: readonly string[]
  readonly skillRefs: readonly AgentSkillRef[]
}): Promise<void> {
  const mcpIds = unique(input.mcpIds)
  if (mcpIds.length > 0) {
    const known = new Set(
      (
        await input.transaction
          .select({ id: mcps.id })
          .from(mcps)
          .where(inArray(mcps.id, mcpIds))
          .all()
      ).map((row) => row.id),
    )
    const missing = mcpIds.filter((id) => !known.has(id))
    if (missing.length > 0) {
      throw new ValidationError(
        'mcp-not-found',
        `agent references unknown mcp(s): ${missing.join(', ')}`,
        { notFound: missing },
      )
    }
  }

  const pluginIds = unique(input.pluginIds)
  if (pluginIds.length > 0) {
    const rows = await input.transaction
      .select({ id: plugins.id, enabled: plugins.enabled })
      .from(plugins)
      .where(inArray(plugins.id, pluginIds))
      .all()
    const byId = new Map(rows.map((row) => [row.id, row.enabled]))
    const missing = pluginIds.filter((id) => !byId.has(id))
    if (missing.length > 0) {
      throw new ValidationError(
        'plugin-not-found',
        `agent references unknown plugin(s): ${missing.join(', ')}`,
        { notFound: missing },
      )
    }
    const disabled = pluginIds.filter((id) => byId.get(id) === false)
    if (disabled.length > 0) {
      throw new ValidationError(
        PLUGIN_DISABLED_ERROR_CODE,
        `agent references disabled plugin(s): ${disabled.join(', ')}`,
        { disabled },
      )
    }
  }

  const skillIds = unique(
    input.skillRefs.flatMap((ref) => (ref.kind === 'managed' ? [ref.skillId] : [])),
  )
  if (skillIds.length > 0) {
    const known = new Set(
      (
        await input.transaction
          .select({ id: skills.id })
          .from(skills)
          .where(and(inArray(skills.id, skillIds), eq(skills.reservationState, 'ready')))
          .all()
      ).map((row) => row.id),
    )
    const missing = skillIds.filter((id) => !known.has(id))
    if (missing.length > 0) {
      throw new ValidationError(
        'skill-not-found',
        `agent references unknown managed skill(s): ${missing.join(', ')}`,
        { notFound: missing },
      )
    }
  }
}

function stringArray(raw: string): string[] {
  try {
    const decoded: unknown = JSON.parse(raw)
    return Array.isArray(decoded)
      ? decoded.filter((value): value is string => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

async function assertAgentDependencyGraph(
  transaction: PostgresqlResourceCatalogTransaction,
  agentId: string,
  dependencyIds: readonly string[],
): Promise<void> {
  if (dependencyIds.includes(agentId)) {
    throw new ValidationError('agent-dependency-self', 'agent cannot depend on itself')
  }
  const visited = new Set<string>()
  const visiting = new Set<string>()

  async function visit(id: string): Promise<void> {
    if (id === agentId || visiting.has(id)) {
      throw new ValidationError('agent-dependency-cycle', 'agent dependency graph contains a cycle')
    }
    if (visited.has(id)) return
    visiting.add(id)
    const row = await transaction
      .select({ dependsOn: agents.dependsOn })
      .from(agents)
      .where(eq(agents.id, id))
      .get()
    if (row === undefined) {
      throw new ValidationError(
        'agent-dependency-not-found',
        `agent dependency '${id}' not found`,
        { notFound: [id] },
      )
    }
    for (const dependency of stringArray(row.dependsOn)) await visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }

  for (const dependencyId of unique(dependencyIds)) await visit(dependencyId)
}

async function assertAgentDefinition(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly agentId: string
  readonly definition: Pick<
    CreateAgent,
    'outputs' | 'branchPorts' | 'runtime' | 'mcp' | 'plugins' | 'skills' | 'dependsOn'
  >
  readonly previousRuntime?: string
}): Promise<void> {
  assertBranchPortsDeclared(input.definition)
  await assertRuntimeReference({
    transaction: input.transaction,
    name: input.definition.runtime,
    ...(input.previousRuntime === undefined ? {} : { previous: input.previousRuntime }),
  })
  await assertAgentResourceRows({
    transaction: input.transaction,
    mcpIds: input.definition.mcp,
    pluginIds: input.definition.plugins,
    skillRefs: input.definition.skills,
  })
  await assertAgentDependencyGraph(input.transaction, input.agentId, input.definition.dependsOn)
}

/** Native PostgreSQL writer for system-owned Digital Employee Agent templates. */
export function createPostgresqlDigitalEmployeeAgentTemplateRepository(
  db: PostgresqlDatabaseClient,
): DigitalEmployeeAgentTemplateRepository {
  async function get(id: string): Promise<Agent | null> {
    const row = await db.select().from(agents).where(eq(agents.id, id)).get()
    return row === undefined ? null : agentFromPersistenceRow(row)
  }

  return Object.freeze({
    get,

    async createBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['createBuiltin']>[0],
    ): Promise<void> {
      try {
        await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
          const existing = await transaction
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.id, input.id))
            .get()
          if (existing !== undefined) throw occupied(input.id)
          const collision = await transaction
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(eq(agents.ownerUserId, SYSTEM_USER_ID), eq(agents.name, input.definition.name)),
            )
            .get()
          if (collision !== undefined) throw nameConflict(input.definition.name)
          await assertAgentDefinition({
            transaction,
            agentId: input.id,
            definition: input.definition,
          })
          const values = createAgentPersistenceValues({
            id: input.id,
            agent: input.definition,
            ownerUserId: SYSTEM_USER_ID,
            now: Date.now(),
          })
          await transaction
            .insert(agents)
            .values({ ...values, visibility: 'public', builtin: true })
            .run()
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['agents_owner_name_unique'])) {
          throw nameConflict(input.definition.name)
        }
        if (isPostgresqlUniqueViolation(error, ['agents_pkey'])) throw occupied(input.id)
        throw error
      }
    },

    async renameBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['renameBuiltin']>[0],
    ): Promise<void> {
      try {
        await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
          const row = await transaction.select().from(agents).where(eq(agents.id, input.id)).get()
          const current = requireSystemBuiltin(input.id, row, input)
          if (current.name === input.newName) return
          const collision = await transaction
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.ownerUserId, SYSTEM_USER_ID),
                eq(agents.name, input.newName),
                ne(agents.id, input.id),
              ),
            )
            .get()
          if (collision !== undefined) throw nameConflict(input.newName)
          const changed = await transaction
            .update(agents)
            .set({ name: input.newName, updatedAt: monotonicNow(current.updatedAt) })
            .where(
              and(
                eq(agents.id, input.id),
                eq(agents.ownerUserId, SYSTEM_USER_ID),
                eq(agents.builtin, true),
                eq(agents.updatedAt, input.expectedUpdatedAt),
                eq(agents.aclRevision, input.expectedAclRevision),
              ),
            )
            .returning({ id: agents.id })
            .get()
          if (changed === undefined) throw stale(input.id)
        })
      } catch (error) {
        if (isPostgresqlUniqueViolation(error, ['agents_owner_name_unique'])) {
          throw nameConflict(input.newName)
        }
        throw error
      }
    },

    async updateBuiltin(
      input: Parameters<DigitalEmployeeAgentTemplateRepository['updateBuiltin']>[0],
    ): Promise<void> {
      await runPostgresqlResourceCatalogTransaction(db, async (transaction) => {
        const row = await transaction.select().from(agents).where(eq(agents.id, input.id)).get()
        const current = requireSystemBuiltin(input.id, row, input)
        const runtime =
          input.patch.runtime === null ? undefined : (input.patch.runtime ?? current.runtime)
        await assertAgentDefinition({
          transaction,
          agentId: input.id,
          definition: {
            outputs: input.patch.outputs ?? current.outputs,
            branchPorts: input.patch.branchPorts ?? current.branchPorts,
            ...(runtime === undefined ? {} : { runtime }),
            mcp: input.patch.mcp ?? current.mcp,
            plugins: input.patch.plugins ?? current.plugins,
            skills: input.patch.skills ?? current.skills,
            dependsOn: input.patch.dependsOn ?? current.dependsOn,
          },
          ...(current.runtime === undefined ? {} : { previousRuntime: current.runtime }),
        })
        const changed = await transaction
          .update(agents)
          .set(updateAgentPersistenceValues(current, input.patch, monotonicNow(current.updatedAt)))
          .where(
            and(
              eq(agents.id, input.id),
              eq(agents.ownerUserId, SYSTEM_USER_ID),
              eq(agents.builtin, true),
              eq(agents.updatedAt, input.expectedUpdatedAt),
              eq(agents.aclRevision, input.expectedAclRevision),
            ),
          )
          .returning({ id: agents.id })
          .get()
        if (changed === undefined) throw stale(input.id)
      })
    },
  })
}
