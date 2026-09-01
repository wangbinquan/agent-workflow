import {
  CreateAgentSchema,
  CreateMcpSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  WorkflowDefinitionSchema,
  definitionHasCodeHostCallNode,
  definitionHasScriptNode,
  migrateWorkflowDefinitionToLatest,
  resolveWorkgroupOutputContract,
  serializeCodeHostSensitiveProjectionV1,
  serializeScriptSensitiveProjectionV1,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  serializeWorkgroupEditableSnapshotV1,
  type Agent,
  type CreateAgent,
  type CreateMcp,
  type PluginSourceKind,
  type Skill,
  type WorkflowDefinition,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  agents,
  mcps,
  plugins,
  resourceGrants,
  runtimes,
  skillVersions,
  skills,
  users,
  workflows,
  workgroupMembers,
  workgroups,
} from '@/db/schema'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  staleConflictError,
} from '@/util/errors'
import { monotonicNow } from '@/util/time'
import { encodeSkillToken } from '../../application/skills/skillToken'
import { hasResourceAclBypass } from '../../domain/resourceAccess'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'
import type {
  IntentResourceChangesetReceipt,
  VersionedIntentResourceChangesetPlan,
} from '../../public/types'
import {
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  updateAgentPersistenceValues,
} from '../agentPersistence'
import { mcpConfigHash, mcpFromPersistenceRow } from '../mcpPersistence'
import { pluginConfigHash, pluginFromPersistenceRow } from '../pluginPersistence'
import type { PostgresqlMcpTransactionLifecycle } from '../postgresqlMcpRepository'
import type { PostgresqlResourceCatalogTransaction } from '../postgresql/repositorySupport'
import { workflowDraftSnapshotOf, workflowFromPersistenceRow } from '../workflowPersistence'
import { workgroupFromPostgresqlRows } from '../postgresqlWorkgroupRepository'
import type {
  PostgresqlIntentApplyArtifact,
  PostgresqlIntentApplyMutationPort,
  PostgresqlIntentApplyResourcePorts,
  PostgresqlIntentApplyResourceSessionOptions,
} from './postgresqlIntentApplyResourceParticipants'

type PlanOf<K extends CatalogSelectorKind> = Extract<
  VersionedIntentResourceChangesetPlan,
  { readonly kind: K }
>
type UpdatePlanOf<K extends CatalogSelectorKind> = Extract<PlanOf<K>, { readonly action: 'update' }>
type ReceiptOf<K extends CatalogSelectorKind> = Extract<
  IntentResourceChangesetReceipt,
  { readonly kind: K }
>

interface StagedArtifactCapability<TResult> {
  readonly artifact: PostgresqlIntentApplyArtifact
  stage(): Promise<TResult>
  compensate(): Promise<void>
  rollForward(): Promise<void>
  complete(): Promise<void>
}

export interface PostgresqlIntentPluginInstallResult {
  readonly sourceKind: PluginSourceKind
  readonly cachedPath: string
  readonly resolvedVersion: string | null
}

/**
 * Filesystem/plugin owner capability. `planInstall` must not mutate the
 * filesystem: the returned artifact is journaled before `stage` is called.
 */
export interface PostgresqlIntentPluginArtifactLifecycle {
  planInstall(input: {
    readonly pluginId: string
    readonly operationId: string
    readonly spec: string
  }): Promise<StagedArtifactCapability<PostgresqlIntentPluginInstallResult>>
}

export interface PostgresqlIntentSkillStageResult {
  readonly managedPath: string
  readonly filesPath: string
  readonly contentHash: string | null
  commitInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    versionIndex: number,
  ): Promise<void>
}

/**
 * Managed-skill filesystem capability. Planning is side-effect free; the
 * Intent journal records `artifact` before the returned `stage` method acts.
 */
export interface PostgresqlIntentSkillArtifactLifecycle {
  planCreate(input: {
    readonly authority: DirectAuthenticatedAuthority
    readonly operationId: string
    readonly skillId: string
    readonly payload: PlanOf<'skill'>['payload']
  }): Promise<StagedArtifactCapability<PostgresqlIntentSkillStageResult>>
  planUpdate(input: {
    readonly authority: DirectAuthenticatedAuthority
    readonly operationId: string
    readonly current: Skill
    readonly payload: PlanOf<'skill'>['payload']
  }): Promise<StagedArtifactCapability<PostgresqlIntentSkillStageResult>>
}

export interface PostgresqlIntentResourceCommitEvent {
  readonly kind: 'workflow' | 'workgroup'
  readonly action: 'create' | 'update'
  readonly resourceId: string
  readonly revision: number
}

export interface PostgresqlIntentApplyResourcePortFactoryDependencies {
  readonly db: PostgresqlDatabaseClient
  readonly mcpLifecycle: PostgresqlMcpTransactionLifecycle
  readonly pluginArtifacts: PostgresqlIntentPluginArtifactLifecycle
  readonly skillArtifacts: PostgresqlIntentSkillArtifactLifecycle
  readonly id?: () => string
  readonly now?: () => number
  readonly committed?: (event: PostgresqlIntentResourceCommitEvent) => Promise<void> | void
}

type PreparedAgent =
  | Readonly<{
      kind: 'create'
      input: CreateAgent
      pendingIds: ReadonlySet<string>
    }>
  | Readonly<{
      kind: 'update'
      patch: Readonly<Record<string, unknown>>
      pendingIds: ReadonlySet<string>
    }>

type PreparedMcp = Readonly<{ input: CreateMcp }>

interface PreparedPlugin {
  readonly install: StagedArtifactCapability<PostgresqlIntentPluginInstallResult> | null
  staged: PostgresqlIntentPluginInstallResult | null
}

interface PreparedSkill {
  readonly stage: StagedArtifactCapability<PostgresqlIntentSkillStageResult>
  staged: PostgresqlIntentSkillStageResult | null
}

type PreparedWorkflow = Readonly<{ definition: WorkflowDefinition }>
type PreparedWorkgroup = Readonly<{ snapshot: WorkgroupDraftSnapshot }>

function exactActor(
  options: PostgresqlIntentApplyResourceSessionOptions,
): DirectAuthenticatedAuthority {
  return options.actor
}

function agentReceipt(
  plan: PlanOf<'agent'>,
  revision: ReceiptOf<'agent'>['revision'],
): ReceiptOf<'agent'> {
  return Object.freeze({
    kind: 'agent',
    operationId: plan.operationId,
    resourceId: plan.resourceId,
    action: plan.action,
    revision,
  })
}

function skillReceipt(
  plan: PlanOf<'skill'>,
  revision: ReceiptOf<'skill'>['revision'],
): ReceiptOf<'skill'> {
  return Object.freeze({
    kind: 'skill',
    operationId: plan.operationId,
    resourceId: plan.resourceId,
    action: plan.action,
    revision,
  })
}

function mcpReceipt(plan: PlanOf<'mcp'>, revision: ReceiptOf<'mcp'>['revision']): ReceiptOf<'mcp'> {
  return Object.freeze({
    kind: 'mcp',
    operationId: plan.operationId,
    resourceId: plan.resourceId,
    action: plan.action,
    revision,
  })
}

function pluginReceipt(
  plan: PlanOf<'plugin'>,
  revision: ReceiptOf<'plugin'>['revision'],
): ReceiptOf<'plugin'> {
  return Object.freeze({
    kind: 'plugin',
    operationId: plan.operationId,
    resourceId: plan.resourceId,
    action: plan.action,
    revision,
  })
}

function workflowReceipt(
  plan: PlanOf<'workflow'>,
  revision: ReceiptOf<'workflow'>['revision'],
): ReceiptOf<'workflow'> {
  return Object.freeze({
    kind: 'workflow',
    operationId: plan.operationId,
    resourceId: plan.resourceId,
    action: plan.action,
    revision,
  })
}

function workgroupReceipt(
  plan: PlanOf<'workgroup'>,
  revision: ReceiptOf<'workgroup'>['revision'],
): ReceiptOf<'workgroup'> {
  return Object.freeze({
    kind: 'workgroup',
    operationId: plan.operationId,
    resourceId: plan.resourceId,
    action: plan.action,
    revision,
  })
}

function notFound(kind: CatalogSelectorKind, id: string): NotFoundError {
  return new NotFoundError(`${kind}-not-found`, `${kind} '${id}' not found`)
}

function requireOwner(
  actor: DirectAuthenticatedAuthority,
  kind: CatalogSelectorKind,
  row: {
    readonly id: string
    readonly ownerUserId?: string | null
    readonly builtin?: boolean
  },
): void {
  if (row.builtin === true) {
    throw new ForbiddenError('builtin-readonly', `built-in ${kind} '${row.id}' is read-only`)
  }
  if (row.ownerUserId !== actor.user.id) {
    throw new ForbiddenError(
      'resource-govern-owner-only',
      `updating ${kind} '${row.id}' through Intent is reserved for its owner`,
    )
  }
}

async function grantExists(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  type: CatalogSelectorKind,
  resourceId: string,
): Promise<boolean> {
  if (hasResourceAclBypass(actor)) return true
  const grant = await transaction
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceType, type),
        eq(resourceGrants.resourceId, resourceId),
        eq(resourceGrants.userId, actor.user.id),
      ),
    )
    .get()
  return grant !== undefined
}

async function visibleIdentity(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  type: CatalogSelectorKind,
  id: string,
): Promise<boolean> {
  const row = await (async () => {
    switch (type) {
      case 'agent':
        return transaction
          .select({ id: agents.id, ownerUserId: agents.ownerUserId, visibility: agents.visibility })
          .from(agents)
          .where(eq(agents.id, id))
          .get()
      case 'skill':
        return transaction
          .select({ id: skills.id, ownerUserId: skills.ownerUserId, visibility: skills.visibility })
          .from(skills)
          .where(eq(skills.id, id))
          .get()
      case 'mcp':
        return transaction
          .select({ id: mcps.id, ownerUserId: mcps.ownerUserId, visibility: mcps.visibility })
          .from(mcps)
          .where(eq(mcps.id, id))
          .get()
      case 'plugin':
        return transaction
          .select({
            id: plugins.id,
            ownerUserId: plugins.ownerUserId,
            visibility: plugins.visibility,
          })
          .from(plugins)
          .where(eq(plugins.id, id))
          .get()
      case 'workflow':
        return transaction
          .select({
            id: workflows.id,
            ownerUserId: workflows.ownerUserId,
            visibility: workflows.visibility,
          })
          .from(workflows)
          .where(eq(workflows.id, id))
          .get()
      case 'workgroup':
        return transaction
          .select({
            id: workgroups.id,
            ownerUserId: workgroups.ownerUserId,
            visibility: workgroups.visibility,
          })
          .from(workgroups)
          .where(eq(workgroups.id, id))
          .get()
    }
  })()
  if (row === undefined) return false
  if (
    hasResourceAclBypass(actor) ||
    row.ownerUserId === actor.user.id ||
    row.visibility === 'public'
  ) {
    return true
  }
  return grantExists(transaction, actor, type, id)
}

async function assertVisibleReferences(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  groups: readonly Readonly<{
    type: CatalogSelectorKind
    ids: readonly string[]
    pendingIds?: ReadonlySet<string>
  }>[],
): Promise<void> {
  const missing: Array<Readonly<{ type: CatalogSelectorKind; id: string }>> = []
  for (const group of groups) {
    for (const id of new Set(group.ids.filter((candidate) => candidate.length > 0))) {
      if (group.pendingIds?.has(id) === true) continue
      if (!(await visibleIdentity(transaction, actor, group.type, id))) {
        missing.push({ type: group.type, id })
      }
    }
  }
  if (missing.length === 0) return
  throw new ValidationError(
    'acl-missing-refs',
    `you do not have access to: ${missing.map((item) => `${item.type} '${item.id}'`).join(', ')}`,
    { missing },
  )
}

function agentReferenceGroups(
  agent: CreateAgent,
  pendingIds: ReadonlySet<string>,
): readonly Readonly<{
  type: CatalogSelectorKind
  ids: readonly string[]
  pendingIds: ReadonlySet<string>
}>[] {
  return [
    { type: 'agent', ids: agent.dependsOn, pendingIds },
    {
      type: 'skill',
      ids: agent.skills.flatMap((ref) => (ref.kind === 'managed' ? [ref.skillId] : [])),
      pendingIds,
    },
    { type: 'mcp', ids: agent.mcp, pendingIds },
    { type: 'plugin', ids: agent.plugins, pendingIds },
  ]
}

function parseStringArray(value: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : []
  } catch {
    return []
  }
}

async function assertAgentGraphAcyclic(
  transaction: PostgresqlResourceCatalogTransaction,
  candidateId: string,
  dependencies: readonly string[],
): Promise<void> {
  if (dependencies.includes(candidateId)) {
    throw new ValidationError('agent-dependency-cycle', 'agent dependency graph contains a cycle')
  }
  const rows = await transaction
    .select({ id: agents.id, dependsOn: agents.dependsOn })
    .from(agents)
    .all()
  const graph = new Map(rows.map((row) => [row.id, parseStringArray(row.dependsOn)] as const))
  graph.set(candidateId, dependencies)
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true
    if (visited.has(id)) return false
    visiting.add(id)
    for (const child of graph.get(id) ?? []) {
      if (visit(child)) return true
    }
    visiting.delete(id)
    visited.add(id)
    return false
  }
  if (visit(candidateId)) {
    throw new ValidationError('agent-dependency-cycle', 'agent dependency graph contains a cycle')
  }
}

async function assertRuntimeExists(
  transaction: PostgresqlResourceCatalogTransaction,
  runtime: string | undefined,
): Promise<void> {
  if (runtime === undefined) return
  const row = await transaction
    .select({ name: runtimes.name })
    .from(runtimes)
    .where(eq(runtimes.name, runtime))
    .get()
  if (row === undefined) {
    throw new ValidationError('agent-runtime-not-found', `runtime '${runtime}' not found`)
  }
}

function exactAgentPatch(plan: UpdatePlanOf<'agent'>): Readonly<Record<string, unknown>> {
  const { name: _name, ...patch } = plan.payload
  return patch
}

function applyAgentPatch(current: Agent, patch: Readonly<Record<string, unknown>>) {
  const candidate: Record<string, unknown> = { ...patch }
  for (const field of ['branchPorts', 'outputKinds', 'role', 'outputWrapperPortNames'] as const) {
    if (!(field in candidate) && current[field] !== undefined) candidate[field] = current[field]
  }
  return UpdateAgentSchema.parse(candidate)
}

function createAgentPort(
  options: PostgresqlIntentApplyResourceSessionOptions,
  now: () => number,
): PostgresqlIntentApplyMutationPort<'agent', PreparedAgent> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan, context) {
      if (plan.action === 'create') {
        return Object.freeze({
          kind: 'create',
          input: CreateAgentSchema.parse(plan.payload),
          pendingIds: context.pendingIds,
        })
      }
      return Object.freeze({
        kind: 'update',
        patch: exactAgentPatch(plan),
        pendingIds: context.pendingIds,
      })
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      const committedAt = now()
      if (prepared.kind === 'create') {
        await assertVisibleReferences(
          transaction,
          actor,
          agentReferenceGroups(prepared.input, prepared.pendingIds),
        )
        await assertAgentGraphAcyclic(transaction, plan.resourceId, prepared.input.dependsOn)
        await assertRuntimeExists(transaction, prepared.input.runtime)
        const collision = await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.ownerUserId, actor.user.id), eq(agents.name, prepared.input.name)))
          .get()
        if (collision !== undefined) {
          throw new ConflictError(
            'agent-name-in-use',
            `agent '${prepared.input.name}' already exists`,
          )
        }
        const inserted = await transaction
          .insert(agents)
          .values(
            createAgentPersistenceValues({
              id: plan.resourceId,
              agent: prepared.input,
              ownerUserId: actor.user.id,
              now: committedAt,
            }),
          )
          .returning()
          .get()
        if (inserted === undefined) throw new Error('agent insert returned no row')
        return agentReceipt(plan, {
          kind: 'agent',
          updatedAt: inserted.updatedAt,
          aclRevision: inserted.aclRevision,
        })
      }
      if (plan.action !== 'update') {
        throw new Error('agent prepared action does not match changeset plan')
      }

      const row = await transaction
        .select()
        .from(agents)
        .where(eq(agents.id, plan.resourceId))
        .get()
      if (row === undefined) throw notFound('agent', plan.resourceId)
      const current = agentFromPersistenceRow(row)
      requireOwner(actor, 'agent', current)
      if (
        current.updatedAt !== plan.expectedRevision.updatedAt ||
        (current.aclRevision ?? 0) !== plan.expectedRevision.aclRevision
      ) {
        throw staleConflictError('agent', `agent '${plan.resourceId}' changed; reload and retry`)
      }
      if (plan.payload.name !== current.name) {
        throw new ValidationError(
          'intent-rename-unsupported',
          'renaming via intent update is not supported; use the finalName slot on a copy, or the rename flow',
        )
      }
      const patch = applyAgentPatch(current, prepared.patch)
      const candidate: CreateAgent = CreateAgentSchema.parse({ ...current, ...patch })
      await assertVisibleReferences(
        transaction,
        actor,
        agentReferenceGroups(candidate, prepared.pendingIds),
      )
      await assertAgentGraphAcyclic(transaction, current.id, candidate.dependsOn)
      await assertRuntimeExists(transaction, candidate.runtime)
      const updatedAt = monotonicNow(current.updatedAt)
      const changed = await transaction
        .update(agents)
        .set(updateAgentPersistenceValues(current, patch, updatedAt))
        .where(
          and(
            eq(agents.id, current.id),
            eq(agents.updatedAt, plan.expectedRevision.updatedAt),
            eq(agents.aclRevision, plan.expectedRevision.aclRevision),
          ),
        )
        .returning()
        .get()
      if (changed === undefined) {
        throw staleConflictError('agent', `agent '${plan.resourceId}' changed; reload and retry`)
      }
      return agentReceipt(plan, {
        kind: 'agent',
        updatedAt: changed.updatedAt,
        aclRevision: changed.aclRevision,
      })
    },
  } satisfies PostgresqlIntentApplyMutationPort<'agent', PreparedAgent>)
}

function mcpConfigWithPreservedOauth(
  submitted: CreateMcp,
  current: ReturnType<typeof mcpFromPersistenceRow>,
): CreateMcp['config'] {
  if (submitted.type !== 'remote' || current.type !== 'remote') return submitted.config
  if (submitted.config.oauth !== undefined || current.config.oauth === undefined) {
    return submitted.config
  }
  return Object.freeze({ ...submitted.config, oauth: current.config.oauth })
}

function createMcpPort(
  options: PostgresqlIntentApplyResourceSessionOptions,
  lifecycle: PostgresqlMcpTransactionLifecycle,
  now: () => number,
): PostgresqlIntentApplyMutationPort<'mcp', PreparedMcp> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      return Object.freeze({ input: CreateMcpSchema.parse(plan.payload) })
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      if (plan.action === 'create') {
        const collision = await transaction
          .select({ id: mcps.id })
          .from(mcps)
          .where(and(eq(mcps.ownerUserId, actor.user.id), eq(mcps.name, prepared.input.name)))
          .get()
        if (collision !== undefined) {
          throw new ConflictError('mcp-name-in-use', `mcp '${prepared.input.name}' already exists`)
        }
        const at = now()
        const inserted = await transaction
          .insert(mcps)
          .values({
            id: plan.resourceId,
            name: prepared.input.name,
            description: prepared.input.description,
            type: prepared.input.type,
            config: JSON.stringify(prepared.input.config),
            enabled: prepared.input.enabled,
            ownerUserId: actor.user.id,
            visibility: 'private',
            aclRevision: 0,
            createdAt: at,
            updatedAt: at,
          })
          .returning()
          .get()
        if (inserted === undefined) throw new Error('mcp insert returned no row')
        return mcpReceipt(plan, {
          kind: 'mcp',
          configHash: mcpConfigHash(mcpFromPersistenceRow(inserted)),
        })
      }

      const row = await transaction.select().from(mcps).where(eq(mcps.id, plan.resourceId)).get()
      if (row === undefined) throw notFound('mcp', plan.resourceId)
      const current = mcpFromPersistenceRow(row)
      requireOwner(actor, 'mcp', current)
      if (mcpConfigHash(current) !== plan.expectedRevision.configHash) {
        throw staleConflictError('mcp', 'the MCP changed; reload before saving')
      }
      if (prepared.input.type !== current.type) {
        throw new ValidationError('mcp-type-immutable', 'mcp type cannot change')
      }
      const updatedAt = monotonicNow(current.updatedAt)
      const changed = await transaction
        .update(mcps)
        .set({
          description: prepared.input.description,
          enabled: prepared.input.enabled,
          config: JSON.stringify(mcpConfigWithPreservedOauth(prepared.input, current)),
          updatedAt,
        })
        .where(and(eq(mcps.id, current.id), eq(mcps.updatedAt, current.updatedAt)))
        .returning()
        .get()
      if (changed === undefined) throw staleConflictError('mcp', 'the MCP changed while saving')
      await lifecycle.transitionMutation(transaction, {
        mcpId: current.id,
        reason: prepared.input.enabled ? 'mcp-config-changed' : 'mcp-disabled',
        now: updatedAt,
      })
      return mcpReceipt(plan, {
        kind: 'mcp',
        configHash: mcpConfigHash(mcpFromPersistenceRow(changed)),
      })
    },
  } satisfies PostgresqlIntentApplyMutationPort<'mcp', PreparedMcp>)
}

function createPluginPort(
  options: PostgresqlIntentApplyResourceSessionOptions,
  db: PostgresqlDatabaseClient,
  artifacts: PostgresqlIntentPluginArtifactLifecycle,
  now: () => number,
): PostgresqlIntentApplyMutationPort<'plugin', PreparedPlugin> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      const current =
        plan.action === 'update'
          ? await artifactsForPluginUpdate(db, artifacts, plan)
          : await artifacts.planInstall({
              pluginId: plan.resourceId,
              operationId: plan.operationId,
              spec: plan.payload.spec,
            })
      return { install: current, staged: null }
    },
    async prestage(_plan, prepared, context) {
      if (prepared.install === null) return
      await context.recordArtifact(prepared.install.artifact)
      prepared.staged = await prepared.install.stage()
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      if (plan.action === 'create') {
        const collision = await transaction
          .select({ id: plugins.id })
          .from(plugins)
          .where(and(eq(plugins.ownerUserId, actor.user.id), eq(plugins.name, plan.payload.name)))
          .get()
        if (collision !== undefined) {
          throw new ConflictError(
            'plugin-name-in-use',
            `plugin '${plan.payload.name}' already exists`,
          )
        }
        if (prepared.staged === null) throw new Error('plugin install result missing')
        const at = now()
        const inserted = await transaction
          .insert(plugins)
          .values({
            id: plan.resourceId,
            name: plan.payload.name,
            spec: plan.payload.spec,
            optionsJson: JSON.stringify(plan.payload.optionsJson ?? {}),
            description: plan.payload.description,
            enabled: plan.payload.enabled ?? true,
            sourceKind: prepared.staged.sourceKind,
            cachedPath: prepared.staged.cachedPath,
            resolvedVersion: prepared.staged.resolvedVersion,
            installedAt: at,
            ownerUserId: actor.user.id,
            visibility: 'private',
            aclRevision: 0,
            createdAt: at,
            updatedAt: at,
          })
          .returning()
          .get()
        if (inserted === undefined) throw new Error('plugin insert returned no row')
        return pluginReceipt(plan, {
          kind: 'plugin',
          configHash: pluginConfigHash(pluginFromPersistenceRow(inserted)),
        })
      }

      const row = await transaction
        .select()
        .from(plugins)
        .where(eq(plugins.id, plan.resourceId))
        .get()
      if (row === undefined) throw notFound('plugin', plan.resourceId)
      const current = pluginFromPersistenceRow(row)
      requireOwner(actor, 'plugin', current)
      if (pluginConfigHash(current) !== plan.expectedRevision.configHash) {
        throw staleConflictError('plugin', 'the plugin changed; reload before saving')
      }
      if (plan.payload.name !== current.name) {
        throw new ValidationError(
          'intent-rename-unsupported',
          'renaming via intent update is not supported',
        )
      }
      const install = prepared.staged
      const updatedAt = monotonicNow(current.updatedAt)
      const changed = await transaction
        .update(plugins)
        .set({
          spec: plan.payload.spec,
          optionsJson: JSON.stringify(plan.payload.optionsJson ?? {}),
          description: plan.payload.description ?? current.description,
          enabled: plan.payload.enabled ?? current.enabled,
          sourceKind: install?.sourceKind ?? current.sourceKind,
          cachedPath: install?.cachedPath ?? current.cachedPath,
          resolvedVersion: install?.resolvedVersion ?? current.resolvedVersion,
          installedAt: install === null ? current.installedAt : monotonicNow(current.installedAt),
          updatedAt,
        })
        .where(and(eq(plugins.id, current.id), eq(plugins.updatedAt, current.updatedAt)))
        .returning()
        .get()
      if (changed === undefined)
        throw staleConflictError('plugin', 'the plugin changed while saving')
      return pluginReceipt(plan, {
        kind: 'plugin',
        configHash: pluginConfigHash(pluginFromPersistenceRow(changed)),
      })
    },
    afterCommitted: async ({ prepared }) => {
      await prepared.install?.complete()
    },
    rollForwardCommitted: async ({ prepared }) => {
      await prepared.install?.rollForward()
    },
    abortPrepared: async ({ prepared, databaseCommitted }) => {
      if (prepared.install === null) return
      if (databaseCommitted) await prepared.install.rollForward()
      else await prepared.install.compensate()
    },
  } satisfies PostgresqlIntentApplyMutationPort<'plugin', PreparedPlugin>)
}

async function artifactsForPluginUpdate(
  db: PostgresqlDatabaseClient,
  artifacts: PostgresqlIntentPluginArtifactLifecycle,
  plan: UpdatePlanOf<'plugin'>,
): Promise<StagedArtifactCapability<PostgresqlIntentPluginInstallResult> | null> {
  const row = await db
    .select({ spec: plugins.spec })
    .from(plugins)
    .where(eq(plugins.id, plan.resourceId))
    .get()
  if (row === undefined) throw notFound('plugin', plan.resourceId)
  if (row.spec === plan.payload.spec) return null
  return artifacts.planInstall({
    pluginId: plan.resourceId,
    operationId: plan.operationId,
    spec: plan.payload.spec,
  })
}

function createSkillPort(
  options: PostgresqlIntentApplyResourceSessionOptions,
  db: PostgresqlDatabaseClient,
  artifacts: PostgresqlIntentSkillArtifactLifecycle,
  nextId: () => string,
  now: () => number,
): PostgresqlIntentApplyMutationPort<'skill', PreparedSkill> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      if (plan.action === 'create') {
        return {
          stage: await artifacts.planCreate({
            authority: actor,
            operationId: plan.operationId,
            skillId: plan.resourceId,
            payload: plan.payload,
          }),
          staged: null,
        }
      }
      const row = await db.select().from(skills).where(eq(skills.id, plan.resourceId)).get()
      if (row === undefined) throw notFound('skill', plan.resourceId)
      const current = skillFromRow(row)
      requireOwner(actor, 'skill', current)
      assertSkillToken(current, plan.expectedRevision.token)
      if (plan.payload.name !== current.name) {
        throw new ValidationError(
          'intent-rename-unsupported',
          'renaming via intent update is not supported',
        )
      }
      return {
        stage: await artifacts.planUpdate({
          authority: actor,
          operationId: plan.operationId,
          current,
          payload: plan.payload,
        }),
        staged: null,
      }
    },
    async prestage(_plan, prepared, context) {
      await context.recordArtifact(prepared.stage.artifact)
      prepared.staged = await prepared.stage.stage()
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      if (prepared.staged === null) throw new Error('skill stage result missing')
      const at = now()
      if (plan.action === 'create') {
        const collision = await transaction
          .select({ id: skills.id })
          .from(skills)
          .where(and(eq(skills.ownerUserId, actor.user.id), eq(skills.name, plan.payload.name)))
          .get()
        if (collision !== undefined) {
          throw new ConflictError(
            'skill-name-in-use',
            `skill '${plan.payload.name}' already exists`,
          )
        }
        await prepared.staged.commitInTransaction(transaction, 1)
        await transaction.insert(skills).values({
          id: plan.resourceId,
          name: plan.payload.name,
          description: plan.payload.description,
          managedPath: prepared.staged.managedPath,
          ownerUserId: actor.user.id,
          visibility: 'private',
          aclRevision: 0,
          contentVersion: 1,
          metaRevision: 0,
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
          createdAt: at,
          updatedAt: at,
        })
        await transaction.insert(skillVersions).values({
          id: nextId(),
          skillId: plan.resourceId,
          versionIndex: 1,
          filesPath: prepared.staged.filesPath,
          source: 'initial',
          summary: 'Initial version',
          fusionId: null,
          restoredFromVersion: null,
          authorUserId: actor.user.id,
          contentHash: prepared.staged.contentHash,
          createdAt: at,
        })
        return skillReceipt(plan, { kind: 'skill', token: skillToken(plan.resourceId, 1, 0) })
      }

      const row = await transaction
        .select()
        .from(skills)
        .where(eq(skills.id, plan.resourceId))
        .get()
      if (row === undefined) throw notFound('skill', plan.resourceId)
      const current = skillFromRow(row)
      requireOwner(actor, 'skill', current)
      assertSkillToken(current, plan.expectedRevision.token)
      const versionIndex = current.contentVersion + 1
      const metaRevision =
        plan.payload.description === current.description
          ? current.metaRevision
          : current.metaRevision + 1
      const updatedAt = monotonicNow(current.updatedAt)
      await prepared.staged.commitInTransaction(transaction, versionIndex)
      const changed = await transaction
        .update(skills)
        .set({
          description: plan.payload.description,
          contentVersion: versionIndex,
          metaRevision,
          versionState: 'snapshot-authoritative',
          updatedAt,
        })
        .where(
          and(
            eq(skills.id, current.id),
            eq(skills.contentVersion, current.contentVersion),
            eq(skills.metaRevision, current.metaRevision),
            eq(skills.aclRevision, current.aclRevision ?? 0),
          ),
        )
        .returning({ id: skills.id })
        .get()
      if (changed === undefined) throw staleConflictError('skill', `skill '${current.id}' changed`)
      await transaction.insert(skillVersions).values({
        id: nextId(),
        skillId: current.id,
        versionIndex,
        filesPath: prepared.staged.filesPath,
        source: 'editor',
        summary: null,
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: actor.user.id,
        contentHash: prepared.staged.contentHash,
        createdAt: updatedAt,
      })
      return skillReceipt(plan, {
        kind: 'skill',
        token: skillToken(current.id, versionIndex, metaRevision),
      })
    },
    afterCommitted: async ({ prepared }) => {
      await prepared.stage.complete()
    },
    rollForwardCommitted: async ({ prepared }) => {
      await prepared.stage.rollForward()
    },
    abortPrepared: async ({ prepared, databaseCommitted }) => {
      if (databaseCommitted) await prepared.stage.rollForward()
      else await prepared.stage.compensate()
    },
  } satisfies PostgresqlIntentApplyMutationPort<'skill', PreparedSkill>)
}

function skillFromRow(row: typeof skills.$inferSelect): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceKind: 'managed',
    managedPath: row.managedPath ?? undefined,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    schemaVersion: row.schemaVersion,
    contentVersion: row.contentVersion,
    aclRevision: row.aclRevision,
    metaRevision: row.metaRevision,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function skillToken(skillId: string, contentVersion: number, metaRevision: number): string {
  return encodeSkillToken({ skillId, contentVersion, metaRevision })
}

function assertSkillToken(skill: Skill, expected: string): void {
  if (skillToken(skill.id, skill.contentVersion, skill.metaRevision) === expected) return
  throw staleConflictError('skill', `skill '${skill.name}' changed; reload and retry`)
}

function assertWorkflowPrivilegedContent(
  actor: DirectAuthenticatedAuthority,
  next: WorkflowDefinition,
  previous?: WorkflowDefinition,
): void {
  const scriptChanged =
    (definitionHasScriptNode(next) ||
      (previous !== undefined && definitionHasScriptNode(previous))) &&
    (previous === undefined ||
      serializeScriptSensitiveProjectionV1(next) !== serializeScriptSensitiveProjectionV1(previous))
  if (scriptChanged && !actor.permissions.has('scripts:author')) {
    throw new ForbiddenError(
      'script-author-forbidden',
      'changing executable script content requires scripts:author',
    )
  }
  const codeHostChanged =
    (definitionHasCodeHostCallNode(next) ||
      (previous !== undefined && definitionHasCodeHostCallNode(previous))) &&
    (previous === undefined ||
      serializeCodeHostSensitiveProjectionV1(next) !==
        serializeCodeHostSensitiveProjectionV1(previous))
  if (codeHostChanged && !actor.permissions.has('code-host-calls:author')) {
    throw new ForbiddenError(
      'code-host-author-forbidden',
      'changing a code-host call requires code-host-calls:author',
    )
  }
}

function workflowAgentIds(definition: WorkflowDefinition): readonly string[] {
  return (definition.nodes ?? []).flatMap((node) =>
    node.kind === 'agent-single' && typeof node.agentId === 'string' && node.agentId.length > 0
      ? [node.agentId]
      : [],
  )
}

async function assertNamedReferencesVisible(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  type: 'workflow' | 'workgroup',
  names: readonly string[],
  createdNames: ReadonlySet<string>,
): Promise<void> {
  for (const name of new Set(names)) {
    if (createdNames.has(name)) continue
    const rows =
      type === 'workflow'
        ? await transaction
            .select({
              id: workflows.id,
              ownerUserId: workflows.ownerUserId,
              visibility: workflows.visibility,
            })
            .from(workflows)
            .where(eq(workflows.name, name))
            .all()
        : await transaction
            .select({
              id: workgroups.id,
              ownerUserId: workgroups.ownerUserId,
              visibility: workgroups.visibility,
            })
            .from(workgroups)
            .where(eq(workgroups.name, name))
            .all()
    if (rows.length === 0) {
      throw new ValidationError(
        'resource-reference-not-found',
        `${type} '${name}' does not resolve to a persisted resource`,
      )
    }
    let visible = false
    for (const row of rows) {
      if (
        hasResourceAclBypass(actor) ||
        row.ownerUserId === actor.user.id ||
        row.visibility === 'public' ||
        (await grantExists(transaction, actor, type, row.id))
      ) {
        visible = true
        break
      }
    }
    if (!visible) {
      throw new ValidationError('acl-missing-refs', `you do not have access to: ${type} '${name}'`)
    }
  }
}

function workflowCallNames(
  definition: WorkflowDefinition,
  kind: 'call-workflow' | 'call-workgroup',
  field: 'workflowName' | 'workgroupName',
): readonly string[] {
  return (definition.nodes ?? []).flatMap((node) => {
    if (node.kind !== kind) return []
    const value = Reflect.get(node, field)
    return typeof value === 'string' && value.length > 0 ? [value] : []
  })
}

function assertCanonicalAgentIds(definition: WorkflowDefinition): void {
  const missing = (definition.nodes ?? [])
    .filter((node) => node.kind === 'agent-single')
    .filter((node) => typeof node.agentId !== 'string' || node.agentId.length === 0)
    .map((node) => node.id)
  if (missing.length > 0) {
    throw new ValidationError(
      'workflow-agent-id-required',
      'agent-single nodes require a canonical agentId',
      { nodeIds: missing },
    )
  }
}

function createWorkflowPort(
  options: PostgresqlIntentApplyResourceSessionOptions,
  committed: PostgresqlIntentApplyResourcePortFactoryDependencies['committed'],
  now: () => number,
): PostgresqlIntentApplyMutationPort<'workflow', PreparedWorkflow> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      const definition = migrateWorkflowDefinitionToLatest(
        WorkflowDefinitionSchema.parse(plan.payload.definition),
      )
      assertCanonicalAgentIds(definition)
      return Object.freeze({ definition })
    },
    async commitInTransaction({ transaction, plan, prepared, context }) {
      const currentRow =
        plan.action === 'update'
          ? await transaction
              .select()
              .from(workflows)
              .where(eq(workflows.id, plan.resourceId))
              .get()
          : undefined
      const current = currentRow === undefined ? undefined : workflowFromPersistenceRow(currentRow)
      if (plan.action === 'update') {
        if (current === undefined) throw notFound('workflow', plan.resourceId)
        requireOwner(actor, 'workflow', current)
        if (plan.payload.name !== current.name) {
          throw new ValidationError(
            'intent-rename-unsupported',
            'renaming via intent update is not supported',
          )
        }
      }
      assertWorkflowPrivilegedContent(actor, prepared.definition, current?.definition)
      await assertVisibleReferences(transaction, actor, [
        { type: 'agent', ids: workflowAgentIds(prepared.definition) },
      ])
      await assertNamedReferencesVisible(
        transaction,
        actor,
        'workflow',
        workflowCallNames(prepared.definition, 'call-workflow', 'workflowName'),
        context.bundleCreatedNames.workflow,
      )
      await assertNamedReferencesVisible(
        transaction,
        actor,
        'workgroup',
        workflowCallNames(prepared.definition, 'call-workgroup', 'workgroupName'),
        context.bundleCreatedNames.workgroup,
      )

      if (plan.action === 'create') {
        const at = now()
        const collision = await transaction
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(eq(workflows.ownerUserId, actor.user.id), eq(workflows.name, plan.payload.name)),
          )
          .get()
        if (collision !== undefined) {
          throw new ConflictError(
            'workflow-name-in-use',
            `workflow '${plan.payload.name}' already exists`,
          )
        }
        const inserted = await transaction
          .insert(workflows)
          .values({
            id: plan.resourceId,
            name: plan.payload.name,
            description: plan.payload.description,
            definition: serializeWorkflowDefinitionStorageV1(prepared.definition),
            version: 1,
            ownerUserId: actor.user.id,
            visibility: 'private',
            aclRevision: 0,
            builtin: false,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ version: workflows.version })
          .get()
        if (inserted === undefined) throw new Error('workflow insert returned no row')
        return workflowReceipt(plan, { kind: 'workflow', version: inserted.version })
      }

      if (current === undefined || currentRow === undefined)
        throw notFound('workflow', plan.resourceId)
      const candidateSnapshot = {
        name: plan.payload.name,
        description: plan.payload.description,
        definition: prepared.definition,
      }
      const currentBytes = serializeWorkflowEditableSnapshotV1(workflowDraftSnapshotOf(current))
      const candidateBytes = serializeWorkflowEditableSnapshotV1(candidateSnapshot)
      if (current.version !== plan.expectedRevision.version) {
        if (currentBytes === candidateBytes) {
          return workflowReceipt(plan, { kind: 'workflow', version: current.version })
        }
        throw staleConflictError('workflow', `workflow '${current.id}' changed; reload`)
      }
      if (currentBytes === candidateBytes) {
        return workflowReceipt(plan, { kind: 'workflow', version: current.version })
      }
      const changed = await transaction
        .update(workflows)
        .set({
          description: plan.payload.description,
          definition: serializeWorkflowDefinitionStorageV1(prepared.definition),
          version: current.version + 1,
          updatedAt: now(),
        })
        .where(and(eq(workflows.id, current.id), eq(workflows.version, current.version)))
        .returning({ version: workflows.version })
        .get()
      if (changed === undefined)
        throw staleConflictError('workflow', `workflow '${current.id}' changed`)
      return workflowReceipt(plan, { kind: 'workflow', version: changed.version })
    },
    afterCommitted: async ({ plan, receipt: result }) => {
      await committed?.({
        kind: 'workflow',
        action: plan.action,
        resourceId: plan.resourceId,
        revision: result.revision.version,
      })
    },
  } satisfies PostgresqlIntentApplyMutationPort<'workflow', PreparedWorkflow>)
}

function workgroupSnapshotFromRows(
  row: typeof workgroups.$inferSelect,
  members: readonly (typeof workgroupMembers.$inferSelect)[],
): WorkgroupDraftSnapshot {
  const group = workgroupFromPostgresqlRows(row, members)
  const ordered = [...group.members].sort((left, right) => left.sortOrder - right.sortOrder)
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return WorkgroupDraftSnapshotSchema.parse({
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    mode: group.mode,
    outputContract: resolveWorkgroupOutputContract(group.outputContract),
    ...(group.mode === 'leader_worker' && leader !== undefined
      ? { leaderDisplayName: leader.displayName }
      : {}),
    switches: group.switches,
    maxRounds: group.maxRounds,
    completionGate: group.completionGate,
    clarifyBudget: group.clarifyBudget ?? 3,
    fanOut: group.fanOut ?? false,
    members: ordered.map((member) =>
      member.memberType === 'agent'
        ? {
            memberType: 'agent',
            agentId: member.agentId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        : {
            memberType: 'human',
            userId: member.userId ?? '',
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          },
    ),
  })
}

async function workgroupMemberValues(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  workgroupId: string,
  members: readonly WorkgroupDraftMember[],
  nextId: () => string,
  now: number,
): Promise<readonly (typeof workgroupMembers.$inferInsert)[]> {
  const agentIds = members.flatMap((member) =>
    member.memberType === 'agent' && member.agentId !== undefined ? [member.agentId] : [],
  )
  await assertVisibleReferences(transaction, actor, [{ type: 'agent', ids: agentIds }])
  const agentRows =
    agentIds.length === 0
      ? []
      : await transaction
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds))
          .all()
  const names = new Map(agentRows.map((row) => [row.id, row.name] as const))
  const userIds = members.flatMap((member) =>
    member.memberType === 'human' && member.userId !== undefined ? [member.userId] : [],
  )
  const activeUsers =
    userIds.length === 0
      ? []
      : await transaction
          .select({ id: users.id })
          .from(users)
          .where(and(inArray(users.id, userIds), eq(users.status, 'active')))
          .all()
  const active = new Set(activeUsers.map((row) => row.id))
  const inactive = userIds.filter((id) => !active.has(id))
  if (inactive.length > 0) {
    throw new ValidationError('workgroup-human-inactive', 'workgroup human members must be active')
  }
  return members.map((member, sortOrder) => ({
    id: nextId(),
    workgroupId,
    memberType: member.memberType,
    agentName:
      member.memberType === 'agent' && member.agentId !== undefined
        ? (names.get(member.agentId) ?? null)
        : null,
    agentId: member.memberType === 'agent' ? (member.agentId ?? null) : null,
    userId: member.memberType === 'human' ? (member.userId ?? null) : null,
    displayName: member.displayName,
    roleDesc: member.roleDesc,
    sortOrder,
    createdAt: now,
  }))
}

function leaderMemberId(
  snapshot: WorkgroupDraftSnapshot,
  members: readonly (typeof workgroupMembers.$inferInsert)[],
): string | null {
  if (snapshot.mode !== 'leader_worker' || snapshot.leaderDisplayName === undefined) return null
  return members.find((member) => member.displayName === snapshot.leaderDisplayName)?.id ?? null
}

function createWorkgroupPort(
  options: PostgresqlIntentApplyResourceSessionOptions,
  committed: PostgresqlIntentApplyResourcePortFactoryDependencies['committed'],
  nextId: () => string,
  now: () => number,
): PostgresqlIntentApplyMutationPort<'workgroup', PreparedWorkgroup> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      const snapshot =
        plan.action === 'create'
          ? (() => {
              const created = CreateWorkgroupSchema.parse(plan.payload)
              return WorkgroupDraftSnapshotSchema.parse({
                ...created,
                outputContract: resolveWorkgroupOutputContract(created.outputContract),
                clarifyBudget: created.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
                fanOut: created.fanOut ?? false,
              })
            })()
          : WorkgroupDraftSnapshotSchema.parse(plan.payload)
      return Object.freeze({ snapshot })
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      const at = now()
      if (plan.action === 'create') {
        const collision = await transaction
          .select({ id: workgroups.id })
          .from(workgroups)
          .where(
            and(
              eq(workgroups.ownerUserId, actor.user.id),
              eq(workgroups.name, prepared.snapshot.name),
            ),
          )
          .get()
        if (collision !== undefined) {
          throw new ConflictError(
            'workgroup-name-in-use',
            `workgroup '${prepared.snapshot.name}' already exists`,
          )
        }
        const members = await workgroupMemberValues(
          transaction,
          actor,
          plan.resourceId,
          prepared.snapshot.members,
          nextId,
          at,
        )
        const row = await transaction
          .insert(workgroups)
          .values({
            id: plan.resourceId,
            name: prepared.snapshot.name,
            description: prepared.snapshot.description,
            instructions: prepared.snapshot.instructions,
            mode: prepared.snapshot.mode,
            outputContract: resolveWorkgroupOutputContract(prepared.snapshot.outputContract),
            leaderMemberId: leaderMemberId(prepared.snapshot, members),
            shareOutputs: prepared.snapshot.switches.shareOutputs,
            directMessages: prepared.snapshot.switches.directMessages,
            blackboard: prepared.snapshot.switches.blackboard,
            maxRounds: prepared.snapshot.maxRounds,
            completionGate: prepared.snapshot.completionGate,
            clarifyBudget: prepared.snapshot.clarifyBudget,
            fanOut: prepared.snapshot.fanOut,
            version: 1,
            ownerUserId: actor.user.id,
            visibility: 'private',
            aclRevision: 0,
            createdAt: at,
            updatedAt: at,
          })
          .returning({ version: workgroups.version })
          .get()
        if (row === undefined) throw new Error('workgroup insert returned no row')
        for (const member of members) await transaction.insert(workgroupMembers).values(member)
        return workgroupReceipt(plan, { kind: 'workgroup', version: row.version })
      }

      const row = await transaction
        .select()
        .from(workgroups)
        .where(eq(workgroups.id, plan.resourceId))
        .get()
      if (row === undefined) throw notFound('workgroup', plan.resourceId)
      requireOwner(actor, 'workgroup', row)
      if (prepared.snapshot.name !== row.name) {
        throw new ValidationError(
          'intent-rename-unsupported',
          'renaming via intent update is not supported',
        )
      }
      const currentMembers = await transaction
        .select()
        .from(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, plan.resourceId))
        .all()
      const currentSnapshot = workgroupSnapshotFromRows(row, currentMembers)
      const currentBytes = serializeWorkgroupEditableSnapshotV1(currentSnapshot)
      const submittedBytes = serializeWorkgroupEditableSnapshotV1(prepared.snapshot)
      if (row.version !== plan.expectedRevision.version) {
        if (currentBytes === submittedBytes) {
          return workgroupReceipt(plan, { kind: 'workgroup', version: row.version })
        }
        throw staleConflictError('workgroup', `workgroup '${row.id}' changed; reload`)
      }
      if (currentBytes === submittedBytes) {
        return workgroupReceipt(plan, { kind: 'workgroup', version: row.version })
      }
      const replacement = await workgroupMemberValues(
        transaction,
        actor,
        plan.resourceId,
        prepared.snapshot.members,
        nextId,
        at,
      )
      const changed = await transaction
        .update(workgroups)
        .set({
          description: prepared.snapshot.description,
          instructions: prepared.snapshot.instructions,
          mode: prepared.snapshot.mode,
          outputContract: resolveWorkgroupOutputContract(prepared.snapshot.outputContract),
          leaderMemberId: leaderMemberId(prepared.snapshot, replacement),
          shareOutputs: prepared.snapshot.switches.shareOutputs,
          directMessages: prepared.snapshot.switches.directMessages,
          blackboard: prepared.snapshot.switches.blackboard,
          maxRounds: prepared.snapshot.maxRounds,
          completionGate: prepared.snapshot.completionGate,
          clarifyBudget: prepared.snapshot.clarifyBudget,
          fanOut: prepared.snapshot.fanOut,
          version: row.version + 1,
          updatedAt: at,
        })
        .where(and(eq(workgroups.id, row.id), eq(workgroups.version, row.version)))
        .returning({ version: workgroups.version })
        .get()
      if (changed === undefined)
        throw staleConflictError('workgroup', `workgroup '${row.id}' changed`)
      await transaction.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, row.id))
      for (const member of replacement) await transaction.insert(workgroupMembers).values(member)
      return workgroupReceipt(plan, { kind: 'workgroup', version: changed.version })
    },
    afterCommitted: async ({ plan, receipt: result }) => {
      await committed?.({
        kind: 'workgroup',
        action: plan.action,
        resourceId: plan.resourceId,
        revision: result.revision.version,
      })
    },
  } satisfies PostgresqlIntentApplyMutationPort<'workgroup', PreparedWorkgroup>)
}

/**
 * The concrete Resource Catalog owner factory. Callers inject only provider
 * lifecycles (MCP transition + filesystem artifacts); all six database arms
 * are fixed here and consume the transaction reserved by Intent.
 */
export function createPostgresqlIntentApplyResourcePortFactory(
  input: PostgresqlIntentApplyResourcePortFactoryDependencies,
): Readonly<{
  create(
    options: PostgresqlIntentApplyResourceSessionOptions,
  ): PostgresqlIntentApplyResourcePorts<
    PreparedAgent,
    PreparedSkill,
    PreparedMcp,
    PreparedPlugin,
    PreparedWorkflow,
    PreparedWorkgroup
  >
}> {
  const nextId = input.id ?? ulid
  const now = input.now ?? Date.now
  return Object.freeze({
    create(options) {
      return Object.freeze({
        agent: createAgentPort(options, now),
        skill: createSkillPort(options, input.db, input.skillArtifacts, nextId, now),
        mcp: createMcpPort(options, input.mcpLifecycle, now),
        plugin: createPluginPort(options, input.db, input.pluginArtifacts, now),
        workflow: createWorkflowPort(options, input.committed, now),
        workgroup: createWorkgroupPort(options, input.committed, nextId, now),
      })
    },
  })
}
