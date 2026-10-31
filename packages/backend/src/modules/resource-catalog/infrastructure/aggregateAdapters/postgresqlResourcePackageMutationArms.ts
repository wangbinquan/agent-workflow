import { capturedSkillTreeColumns } from '../databaseSkillTrees'
import { assertAgentDependencyGraph as validateDependencyGraph } from '../../domain/agentDependencies'
import { createAgentDependencyReadPort } from '../agentDependencyRead'
import { createAgentReferenceWriteParticipant } from '../agentReferenceWrite'
import { createWorkflowDefinitionWriteParticipant } from '../workflowDefinitionWrite'
import { workflowCatalogPredicate } from '../workflowCatalogPredicate'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type {
  ResourcePackageSkillPublication as PostgresqlResourcePackageSkillPublication,
  ResourcePackagePluginPublication as PostgresqlResourcePackagePluginPublication,
} from '../../application/package/artifactOwners'
export type {
  ResourcePackageSkillPublication as PostgresqlResourcePackageSkillPublication,
  ResourcePackagePluginPublication as PostgresqlResourcePackagePluginPublication,
} from '../../application/package/artifactOwners'
import {
  workgroupMemberPersistenceValues,
  workgroupSnapshotValues,
  resolveWorkgroupLeaderMemberId as workgroupLeaderMemberId,
} from '../workgroupPersistence'
import {
  collectWorkflowDependencyRefs,
  agentReferenceIds,
  CreateAgentSchema,
  CreateManagedSkillSchema,
  CreateMcpSchema,
  CreatePluginSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  UpdateMcpSchema,
  UpdatePluginSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkflowDefinitionSchema,
  WorkflowDraftSnapshotSchema,
  WorkgroupDraftSnapshotSchema,
  decodeBundleAgentSkillRef,
  decodeBundleCallRef,
  decodeBundleIdentityRef,
  migrateWorkflowDefinitionToLatest,
  resolveWorkgroupOutputContract,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  serializeWorkgroupEditableSnapshotV1,
  type Agent,
  type AgentSkillRef,
  type AclResourceType,
  type BundleResourceType,
  type CreateAgent,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import {
  reconcileCreatedAgentExecutionContractPorts,
  reconcileUpdatedAgentExecutionContractPorts,
} from '@/modules/resource-catalog/domain/agentExecutionContractPorts'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import type { McpTransactionLifecycle } from '../mcpRepository'
import { loadAgentPersistenceRow } from '../agentPersistence'
import { assertBranchPortsDeclared, assertRuntimeReference } from '../agentBranchPorts'
import { insertMcpRowInTx, mcpFromPersistenceRow, updateMcpRowInTx } from '../mcpPersistence'
import {
  insertPluginRowInTx,
  pluginFromPersistenceRow,
  publishPluginRowInTx,
} from '../pluginPersistence'
import {
  type PostgresqlResourceCatalogTransaction,
  isPostgresqlUniqueViolation,
} from '../postgresql/repositorySupport'

import {
  createWorkflowPersistenceValues,
  workflowDraftSnapshotOf,
  workflowFromPersistenceRow,
} from '../workflowPersistence'
import { workgroupFromRows } from '../workgroupRepository'
import {
  type AgentPackageMutation,
  type CapabilityTemplatePackageMutation,
  type McpPackageMutation,
  type PluginPackageMutation,
  type ResourcePackageMutationReceipt,
  type SkillPackageMutation,
  type WorkflowPackageMutation,
  type WorkgroupPackageMutation,
  PLUGIN_DISABLED_ERROR_CODE,
} from '../../public/types'

import type {
  PostgresqlResourcePackageMutationRequestContext,
  PostgresqlResourcePackageTransactionReader,
} from './postgresqlResourcePackageMutationParticipants'

export interface PostgresqlResourcePackagePendingName {
  readonly type: BundleResourceType
  readonly localSlug: string
  readonly resourceId: string
  readonly name: string
}

interface MutationArmInput<TMutation> {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly mutation: TMutation
  readonly resourceId: string
  readonly pendingNames: ReadonlyMap<string, PostgresqlResourcePackagePendingName>
  readonly id: () => string
  readonly now: () => number
}

interface SkillMutationArmInput extends MutationArmInput<SkillPackageMutation> {
  readonly contentKind?: 'local-file' | 'database-bytes'
  readonly publication: PostgresqlResourcePackageSkillPublication & {
    readonly contentKind?: 'local-file' | 'database-bytes'
  }
}

interface PluginMutationArmInput extends MutationArmInput<PluginPackageMutation> {
  readonly publication: PostgresqlResourcePackagePluginPublication
}

function pendingNameKey(type: BundleResourceType, localSlug: string): string {
  return `${type}\u0000${localSlug}`
}

function invalidReference(type: AclResourceType, wire: string): ValidationError {
  return new ValidationError(
    'bundle-ref-invalid',
    `bundle reference '${wire}' is not a valid ${type} reference`,
  )
}

function missingReference(type: AclResourceType, id: string): ValidationError {
  return new ValidationError('acl-missing-refs', `you do not have access to: ${type} '${id}'`, {
    missing: [{ type, name: id }],
  })
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)]
}

async function resolveIdentityReference(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly type: BundleResourceType
  readonly wire: string
  readonly grandfatheredIds?: ReadonlySet<string>
}): Promise<string> {
  const decoded = decodeBundleIdentityRef(input.wire)
  if (decoded === null) throw invalidReference(input.type, input.wire)
  if (decoded.k === 'local') {
    const resourceId = input.context.ids.findCreate({
      type: input.type,
      localSlug: decoded.slug,
    })
    if (resourceId === null) throw invalidReference(input.type, input.wire)
    return resourceId
  }
  if (decoded.k === 'external') {
    if (input.grandfatheredIds?.has(decoded.token) === true) {
      const existing = await input.reader.getById(input.type, decoded.token)
      if (existing === null) throw missingReference(input.type, decoded.token)
      return existing.id
    }
    return (await input.reader.assertVisible(input.type, decoded.token)).id
  }
  if (decoded.k === 'builtin' && decoded.type === input.type) {
    const builtin = await input.reader.findBuiltin(input.type, decoded.name)
    if (builtin === null) {
      throw new ValidationError(
        'bundle-builtin-missing',
        `this instance has no builtin ${input.type} named '${decoded.name}'`,
      )
    }
    return builtin.id
  }
  throw invalidReference(input.type, input.wire)
}

async function resolveAgentSkillReference(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly wire: string
  readonly grandfatheredIds?: ReadonlySet<string>
}): Promise<AgentSkillRef> {
  const decoded = decodeBundleAgentSkillRef(input.wire)
  if (decoded === null) throw invalidReference('skill', input.wire)
  if (decoded.k === 'project-skill') {
    return { kind: 'project', name: decoded.name }
  }
  const skillId = await resolveIdentityReference({
    reader: input.reader,
    context: input.context,
    type: 'skill',
    wire: input.wire,
    ...(input.grandfatheredIds === undefined ? {} : { grandfatheredIds: input.grandfatheredIds }),
  })
  return { kind: 'managed', skillId }
}

async function assertAgentResourceRows(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly mcpIds: readonly string[]
  readonly pluginIds: readonly string[]
  readonly skillRefs: readonly AgentSkillRef[]
}): Promise<void> {
  const mcpIds = uniqueStrings(input.mcpIds)
  if (mcpIds.length > 0) {
    const { mcps } = tablesOf(input.transaction)
    const known = new Set(
      (
        await input.transaction.select({ id: mcps.id }).from(mcps).where(inArray(mcps.id, mcpIds))
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

  const pluginIds = uniqueStrings(input.pluginIds)
  if (pluginIds.length > 0) {
    const { plugins } = tablesOf(input.transaction)
    const rows = await input.transaction
      .select({ id: plugins.id, enabled: plugins.enabled })
      .from(plugins)
      .where(inArray(plugins.id, pluginIds))
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

  const skillIds = uniqueStrings(agentReferenceIds({ skills: input.skillRefs }, 'skill'))
  if (skillIds.length > 0) {
    const { skills } = tablesOf(input.transaction)
    const known = new Set(
      (
        await input.transaction
          .select({ id: skills.id })
          .from(skills)
          .where(and(inArray(skills.id, skillIds), eq(skills.reservationState, 'ready')))
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

async function assertAgentDependencyGraph(
  transaction: PostgresqlResourceCatalogTransaction,
  agentId: string,
  dependencyIds: readonly string[],
): Promise<void> {
  await validateDependencyGraph({
    candidateId: agentId,
    dependencies: dependencyIds,
    roots: uniqueStrings(dependencyIds),
    load: createAgentDependencyReadPort(transaction, 'package').load,
    semantics: 'catalog',
  })
}

async function resolvedAgentInput(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly mutation: AgentPackageMutation
  readonly current?: Agent
}): Promise<CreateAgent> {
  const current = input.current
  const skills = await Promise.all(
    input.mutation.payload.skills.map((wire) =>
      resolveAgentSkillReference({
        reader: input.reader,
        context: input.context,
        wire,
        ...(current === undefined
          ? {}
          : {
              grandfatheredIds: new Set(agentReferenceIds(current, 'skill')),
            }),
      }),
    ),
  )
  const resolveMany = async (
    type: 'agent' | 'mcp' | 'plugin',
    wires: readonly string[],
    grandfathered: readonly string[],
  ): Promise<string[]> =>
    uniqueStrings(
      await Promise.all(
        wires.map((wire) =>
          resolveIdentityReference({
            reader: input.reader,
            context: input.context,
            type,
            wire,
            ...(current === undefined ? {} : { grandfatheredIds: new Set(grandfathered) }),
          }),
        ),
      ),
    )
  const dependsOn = await resolveMany(
    'agent',
    input.mutation.payload.dependsOn,
    current?.dependsOn ?? [],
  )
  const mcp = await resolveMany('mcp', input.mutation.payload.mcp, current?.mcp ?? [])
  const pluginIds = await resolveMany(
    'plugin',
    input.mutation.payload.plugins,
    current?.plugins ?? [],
  )
  return CreateAgentSchema.parse({
    ...input.mutation.payload,
    skills,
    dependsOn,
    mcp,
    plugins: pluginIds,
  })
}

function ownerScopedNameWhere(
  table:
    | PersistenceTables['agents']
    | PersistenceTables['skills']
    | PersistenceTables['mcps']
    | PersistenceTables['plugins']
    | PersistenceTables['workgroups'],
  ownerUserId: string,
  name: string,
) {
  return and(eq(table.ownerUserId, ownerUserId), eq(table.name, name))
}

async function assertOwnedOverwrite(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly type: BundleResourceType
  readonly resourceId: string
  readonly mutation:
    | AgentPackageMutation
    | SkillPackageMutation
    | McpPackageMutation
    | PluginPackageMutation
    | WorkflowPackageMutation
    | WorkgroupPackageMutation
    | CapabilityTemplatePackageMutation
}): Promise<void> {
  if (input.mutation.kind.endsWith('-create')) return
  let selected
  switch (input.type) {
    case 'agent': {
      if (input.mutation.kind !== 'agent-update') throw new Error('package-agent-kind-mismatch')
      selected = await input.reader.assertSelected({
        type: 'agent',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'agent-revision', ...input.mutation.expect },
      })
      break
    }
    case 'skill': {
      if (input.mutation.kind !== 'skill-update') throw new Error('package-skill-kind-mismatch')
      selected = await input.reader.assertSelected({
        type: 'skill',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'skill-revision', ...input.mutation.expect },
      })
      break
    }
    case 'mcp': {
      if (input.mutation.kind !== 'mcp-update') throw new Error('package-mcp-kind-mismatch')
      selected = await input.reader.assertSelected({
        type: 'mcp',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'mcp-config', ...input.mutation.expect },
      })
      break
    }
    case 'plugin': {
      if (input.mutation.kind !== 'plugin-update') throw new Error('package-plugin-kind-mismatch')
      selected = await input.reader.assertSelected({
        type: 'plugin',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'plugin-config', ...input.mutation.expect },
      })
      break
    }
    case 'workflow': {
      if (input.mutation.kind !== 'workflow-update') {
        throw new Error('package-workflow-kind-mismatch')
      }
      selected = await input.reader.assertSelected({
        type: 'workflow',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'workflow-version', ...input.mutation.expect },
      })
      break
    }
    case 'workgroup': {
      if (input.mutation.kind !== 'workgroup-update') {
        throw new Error('package-workgroup-kind-mismatch')
      }
      selected = await input.reader.assertSelected({
        type: 'workgroup',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'workgroup-version', ...input.mutation.expect },
      })
      break
    }
    case 'capability_template': {
      if (
        input.mutation.kind === 'capability-framework-create' ||
        input.mutation.kind === 'capability-binding-create' ||
        input.mutation.kind === 'capability-template-create'
      ) {
        return
      }
      if (
        input.mutation.kind !== 'capability-framework-update' &&
        input.mutation.kind !== 'capability-binding-update' &&
        input.mutation.kind !== 'capability-template-update'
      ) {
        throw new Error('package-capability-template-kind-mismatch')
      }
      selected = await input.reader.assertSelected({
        type: 'capability_template',
        action: 'overwrite',
        id: input.resourceId,
        fence: { kind: 'capability-template-revision', ...input.mutation.expect },
      })
      break
    }
  }
  if (selected.ownerUserId !== input.context.actor.user.id) {
    throw new ValidationError(
      'bundle-overwrite-not-owned',
      `cannot overwrite ${input.type} '${input.resourceId}': it belongs to another user`,
    )
  }
  if (selected.builtin) {
    throw new ValidationError(
      'resource-builtin-read-only',
      `cannot overwrite builtin ${input.type} '${input.resourceId}'`,
    )
  }
}

function receipt<K extends ResourcePackageMutationReceipt['resourceType']>(
  resourceType: K,
  mutation: { readonly opId: string; readonly kind: string; readonly payload: { name: string } },
  resourceId: string,
): ResourcePackageMutationReceipt<K> {
  return Object.freeze({
    resourceType,
    operationId: mutation.opId,
    resourceId,
    action: mutation.kind.endsWith('-create') ? 'create' : 'update',
    name: mutation.payload.name,
  })
}

export async function commitPostgresqlAgentPackageMutation(
  input: MutationArmInput<AgentPackageMutation>,
): Promise<ResourcePackageMutationReceipt<'agent'>> {
  if (input.mutation.kind === 'agent-create') {
    const canonical = reconcileCreatedAgentExecutionContractPorts(
      await resolvedAgentInput({
        reader: input.reader,
        context: input.context,
        mutation: input.mutation,
      }),
    )
    assertBranchPortsDeclared(canonical)
    await assertRuntimeReference({ transaction: input.transaction, name: canonical.runtime })
    await assertAgentResourceRows({
      transaction: input.transaction,
      mcpIds: canonical.mcp,
      pluginIds: canonical.plugins,
      skillRefs: canonical.skills,
    })
    await assertAgentDependencyGraph(input.transaction, input.resourceId, canonical.dependsOn)
    const { agents } = tablesOf(input.transaction)
    const collision = await first(
      input.transaction
        .select({ id: agents.id })
        .from(agents)
        .where(ownerScopedNameWhere(agents, input.context.actor.user.id, canonical.name)),
    )
    if (collision !== undefined) {
      throw new ConflictError('agent-name-in-use', `agent '${canonical.name}' already exists`)
    }
    try {
      await createAgentReferenceWriteParticipant(input.transaction).insert({
        id: input.resourceId,
        agent: canonical,
        ownerUserId: input.context.actor.user.id,
        now: input.now(),
      })
    } catch (error) {
      if (isPostgresqlUniqueViolation(error, ['agents_owner_name_unique'])) {
        throw new ConflictError('agent-name-in-use', `agent '${canonical.name}' already exists`)
      }
      throw error
    }
    return receipt('agent', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'agent',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { agents } = tablesOf(input.transaction)
  const row = await first(
    input.transaction.select().from(agents).where(eq(agents.id, input.resourceId)),
  )
  if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
  const current = await loadAgentPersistenceRow(input.transaction, row)
  const resolved = await resolvedAgentInput({
    reader: input.reader,
    context: input.context,
    mutation: input.mutation,
    current,
  })
  const { name: _name, ...updateBody } = resolved
  const patch = reconcileUpdatedAgentExecutionContractPorts(
    current,
    UpdateAgentSchema.parse(updateBody),
  )
  assertBranchPortsDeclared({ ...current, ...patch })
  if (patch.runtime !== undefined) {
    await assertRuntimeReference({
      transaction: input.transaction,
      name: patch.runtime,
      ...(current.runtime === undefined ? {} : { previous: current.runtime }),
    })
  }
  const next = {
    mcp: patch.mcp ?? current.mcp,
    plugins: patch.plugins ?? current.plugins,
    skills: patch.skills ?? current.skills,
    dependsOn: patch.dependsOn ?? current.dependsOn,
  }
  await assertAgentResourceRows({
    transaction: input.transaction,
    mcpIds: next.mcp,
    pluginIds: next.plugins,
    skillRefs: next.skills,
  })
  await assertAgentDependencyGraph(input.transaction, current.id, next.dependsOn)
  const changed = (
    await createAgentReferenceWriteParticipant(input.transaction).update({
      current,
      patch,
      updatedAt: monotonicNow(current.updatedAt),
      expectedUpdatedAt: input.mutation.expect.expectedUpdatedAt,
      expectedAclRevision: input.mutation.expect.expectedAclRevision,
      ownerUserId: input.context.actor.user.id,
      builtin: false,
    })
  )[0]
  if (changed === undefined) {
    throw staleConflictError('agent', `agent '${input.resourceId}' changed; reload and retry`)
  }
  return receipt('agent', input.mutation, input.resourceId)
}

export async function commitPostgresqlSkillPackageMutation(
  input: SkillMutationArmInput,
): Promise<ResourcePackageMutationReceipt<'skill'>> {
  const parsed = CreateManagedSkillSchema.parse(input.mutation.payload)
  if (input.mutation.kind === 'skill-create') {
    const { skills, skillVersions } = tablesOf(input.transaction)
    const collision = await first(
      input.transaction
        .select({ id: skills.id })
        .from(skills)
        .where(ownerScopedNameWhere(skills, input.context.actor.user.id, parsed.name)),
    )
    if (collision !== undefined) {
      throw new ConflictError('skill-name-in-use', `skill '${parsed.name}' already exists`)
    }
    const now = input.now()
    try {
      await insertOne(input.transaction, skills, {
        id: input.resourceId,
        name: parsed.name,
        description: parsed.description,
        ...(await capturedSkillTreeColumns(
          input.contentKind ?? input.publication.contentKind ?? 'local-file',
          input.resourceId,
          'live',
          input.publication.managedPath,
        )),
        ownerUserId: input.context.actor.user.id,
        visibility: 'private',
        aclRevision: 0,
        contentVersion: 1,
        metaRevision: 0,
        reservationState: 'ready',
        versionState: 'snapshot-authoritative',
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      await insertOne(input.transaction, skillVersions, {
        id: input.id(),
        skillId: input.resourceId,
        versionIndex: 1,
        ...(await capturedSkillTreeColumns(
          input.contentKind ?? input.publication.contentKind ?? 'local-file',
          input.resourceId,
          'version:1',
          input.publication.filesPath,
        )),
        source: 'initial',
        summary: 'Initial version',
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: input.context.actor.user.id,
        contentHash: input.publication.contentHash,
        createdAt: now,
      })
    } catch (error) {
      if (isPostgresqlUniqueViolation(error, ['skills_owner_name_unique'])) {
        throw new ConflictError('skill-name-in-use', `skill '${parsed.name}' already exists`)
      }
      throw error
    }
    return receipt('skill', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'skill',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { skills, skillVersions } = tablesOf(input.transaction)
  const row = await first(
    input.transaction.select().from(skills).where(eq(skills.id, input.resourceId)),
  )
  if (row === undefined || row.reservationState !== 'ready') {
    throw new NotFoundError('skill-not-found', `skill '${input.resourceId}' not found`)
  }
  const nextVersion = row.contentVersion + 1
  const updatedAt = monotonicNow(row.updatedAt)
  const changed = await first(
    input.transaction
      .update(skills)
      .set({
        description: parsed.description,
        contentVersion: nextVersion,
        ...(await capturedSkillTreeColumns(
          input.contentKind ?? input.publication.contentKind ?? 'local-file',
          input.resourceId,
          'live',
          input.publication.managedPath,
        )),
        metaRevision:
          parsed.description === row.description ? row.metaRevision : row.metaRevision + 1,
        versionState: 'snapshot-authoritative',
        updatedAt,
      })
      .where(
        and(
          eq(skills.id, input.resourceId),
          eq(skills.contentVersion, input.mutation.expect.expectedContentVersion),
          eq(skills.metaRevision, input.mutation.expect.expectedMetaRevision),
          eq(skills.aclRevision, input.mutation.expect.expectedAclRevision),
          eq(skills.ownerUserId, input.context.actor.user.id),
          eq(skills.reservationState, 'ready'),
        ),
      )
      .returning({ id: skills.id }),
  )
  if (changed === undefined) {
    throw staleConflictError('skill', `skill '${input.resourceId}' changed; reload and retry`)
  }
  await insertOne(input.transaction, skillVersions, {
    id: input.id(),
    skillId: input.resourceId,
    versionIndex: nextVersion,
    ...(await capturedSkillTreeColumns(
      input.contentKind ?? input.publication.contentKind ?? 'local-file',
      input.resourceId,
      `version:${nextVersion}`,
      input.publication.filesPath,
    )),
    source: 'import',
    summary: null,
    fusionId: null,
    restoredFromVersion: null,
    authorUserId: input.context.actor.user.id,
    contentHash: input.publication.contentHash,
    createdAt: updatedAt,
  })
  return receipt('skill', input.mutation, input.resourceId)
}

export async function commitPostgresqlMcpPackageMutation(
  input: MutationArmInput<McpPackageMutation> & {
    readonly lifecycle: McpTransactionLifecycle
  },
): Promise<ResourcePackageMutationReceipt<'mcp'>> {
  const parsed = CreateMcpSchema.parse(input.mutation.payload)
  if (input.mutation.kind === 'mcp-create') {
    const { mcps } = tablesOf(input.transaction)
    const collision = await first(
      input.transaction
        .select({ id: mcps.id })
        .from(mcps)
        .where(ownerScopedNameWhere(mcps, input.context.actor.user.id, parsed.name)),
    )
    if (collision !== undefined) {
      throw new ConflictError('mcp-name-in-use', `mcp '${parsed.name}' already exists`)
    }
    const now = input.now()
    try {
      await insertMcpRowInTx(input.transaction, {
        id: input.resourceId,
        input: parsed,
        ownerUserId: input.context.actor.user.id,
        visibility: 'private',
        aclRevision: 0,
        now,
      })
    } catch (error) {
      if (isPostgresqlUniqueViolation(error, ['mcps_owner_name_unique'])) {
        throw new ConflictError('mcp-name-in-use', `mcp '${parsed.name}' already exists`)
      }
      throw error
    }
    return receipt('mcp', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'mcp',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { mcps } = tablesOf(input.transaction)
  const row = await first(
    input.transaction.select().from(mcps).where(eq(mcps.id, input.resourceId)),
  )
  if (row === undefined) throw new NotFoundError('mcp-not-found', 'mcp not found')
  const current = mcpFromPersistenceRow(row)
  const { name: _name, ...updateBody } = input.mutation.payload
  const patch = UpdateMcpSchema.parse(updateBody)
  if (patch.type !== undefined && patch.type !== current.type) {
    throw new ValidationError('mcp-type-immutable', 'mcp type cannot change')
  }
  const updatedAt = monotonicNow(row.updatedAt)
  const changed = await updateMcpRowInTx(
    input.transaction,
    { kind: 'captured-row', row },
    {
      description: patch.description ?? current.description,
      enabled: patch.enabled ?? current.enabled,
      config: JSON.stringify(patch.config ?? current.config),
      updatedAt,
    },
  )
  if (changed.length === 0) {
    throw staleConflictError('mcp', 'the MCP changed while saving; reload and retry')
  }
  await input.lifecycle.transitionMutation(input.transaction, {
    mcpId: input.resourceId,
    reason: (patch.enabled ?? current.enabled) ? 'mcp-config-changed' : 'mcp-disabled',
    now: updatedAt,
  })
  return receipt('mcp', input.mutation, input.resourceId)
}

export async function commitPostgresqlPluginPackageMutation(
  input: PluginMutationArmInput,
): Promise<ResourcePackageMutationReceipt<'plugin'>> {
  const parsed = CreatePluginSchema.parse(input.mutation.payload)
  if (input.mutation.kind === 'plugin-create') {
    const { plugins } = tablesOf(input.transaction)
    const collision = await first(
      input.transaction
        .select({ id: plugins.id })
        .from(plugins)
        .where(ownerScopedNameWhere(plugins, input.context.actor.user.id, parsed.name)),
    )
    if (collision !== undefined) {
      throw new ConflictError('plugin-name-in-use', `plugin '${parsed.name}' already exists`)
    }
    const now = input.now()
    try {
      await insertPluginRowInTx(input.transaction, {
        id: input.resourceId,
        name: parsed.name,
        spec: parsed.spec,
        options: parsed.options,
        description: parsed.description,
        enabled: parsed.enabled,
        sourceKind: input.publication.sourceKind,
        cachedPath: input.publication.cachedPath,
        resolvedVersion: input.publication.resolvedVersion,
        ownerUserId: input.context.actor.user.id,
        visibility: 'private',
        aclRevision: 0,
        now,
      })
    } catch (error) {
      if (isPostgresqlUniqueViolation(error, ['plugins_owner_name_unique'])) {
        throw new ConflictError('plugin-name-in-use', `plugin '${parsed.name}' already exists`)
      }
      throw error
    }
    return receipt('plugin', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'plugin',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { plugins } = tablesOf(input.transaction)
  const row = await first(
    input.transaction.select().from(plugins).where(eq(plugins.id, input.resourceId)),
  )
  if (row === undefined) {
    throw new NotFoundError('plugin-not-found', `plugin '${input.resourceId}' not found`)
  }
  const current = pluginFromPersistenceRow(row)
  const { name: _name, sourceKind: _sourceKind, ...updateBody } = input.mutation.payload
  const patch = UpdatePluginSchema.parse(updateBody)
  const now = input.now()
  const [changed] = await publishPluginRowInTx(input.transaction, row, {
    spec: patch.spec ?? current.spec,
    optionsJson: JSON.stringify(patch.options ?? current.options),
    description: patch.description ?? current.description,
    enabled: patch.enabled ?? current.enabled,
    sourceKind: input.publication.sourceKind,
    cachedPath: input.publication.cachedPath,
    resolvedVersion: input.publication.resolvedVersion,
    installedAt: now,
    updatedAt: monotonicNow(row.updatedAt),
  })
  if (changed === undefined) {
    throw staleConflictError(
      'plugin',
      `plugin '${input.resourceId}' changed while the operation was running; reload and retry`,
    )
  }
  return receipt('plugin', input.mutation, input.resourceId)
}

async function resolveCallReference(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly pendingNames: ReadonlyMap<string, PostgresqlResourcePackagePendingName>
  readonly type: 'workflow' | 'workgroup'
  readonly wire: string
  readonly grandfatheredIds?: ReadonlySet<string>
  readonly grandfatheredNames?: ReadonlySet<string>
}): Promise<{ readonly name: string; readonly idHint?: string }> {
  const decoded = decodeBundleCallRef(input.wire)
  if (decoded === null) throw invalidReference(input.type, input.wire)
  if (decoded.k === 'name' && decoded.type === input.type) return { name: decoded.name }
  if (decoded.k === 'local') {
    const pending = input.pendingNames.get(pendingNameKey(input.type, decoded.slug))
    const resourceId = input.context.ids.findCreate({ type: input.type, localSlug: decoded.slug })
    if (pending === undefined || resourceId === null || pending.resourceId !== resourceId) {
      throw invalidReference(input.type, input.wire)
    }
    return { name: pending.name, idHint: resourceId }
  }
  if (decoded.k === 'external') {
    if (
      input.grandfatheredIds?.has(decoded.token) === true ||
      input.grandfatheredNames !== undefined
    ) {
      const existing = await input.reader.getById(input.type, decoded.token)
      if (
        existing !== null &&
        (input.grandfatheredIds?.has(existing.id) === true ||
          input.grandfatheredNames?.has(existing.name) === true)
      ) {
        return { name: existing.name, idHint: existing.id }
      }
    }
    const resource = await input.reader.assertVisible(input.type, decoded.token)
    return { name: resource.name, idHint: resource.id }
  }
  if (decoded.k === 'builtin' && decoded.type === input.type) {
    const resource = await input.reader.findBuiltin(input.type, decoded.name)
    if (resource === null) {
      throw new ValidationError(
        'bundle-builtin-missing',
        `this instance has no builtin ${input.type} named '${decoded.name}'`,
      )
    }
    return { name: resource.name, idHint: resource.id }
  }
  throw invalidReference(input.type, input.wire)
}

async function resolvedWorkflowDefinition(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly pendingNames: ReadonlyMap<string, PostgresqlResourcePackagePendingName>
  readonly definition: Readonly<Record<string, unknown>>
  readonly grandfathered?: WorkflowGrandfatheredReferences
}): Promise<ReturnType<typeof WorkflowDefinitionSchema.parse>> {
  const rawNodes = input.definition.nodes
  const nodes = await Promise.all(
    (Array.isArray(rawNodes) ? rawNodes : []).map(async (raw) => {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
      const node = Object.fromEntries(Object.entries(raw))
      if (typeof node.agentRef === 'string') {
        node.agentId = await resolveIdentityReference({
          reader: input.reader,
          context: input.context,
          type: 'agent',
          wire: node.agentRef,
          ...(input.grandfathered === undefined
            ? {}
            : { grandfatheredIds: input.grandfathered.agentIds }),
        })
        delete node.agentRef
      }
      if (typeof node.workflowRef === 'string') {
        const resolved = await resolveCallReference({
          reader: input.reader,
          context: input.context,
          pendingNames: input.pendingNames,
          type: 'workflow',
          wire: node.workflowRef,
          ...(input.grandfathered === undefined
            ? {}
            : {
                grandfatheredIds: input.grandfathered.workflowIds,
                grandfatheredNames: input.grandfathered.workflowNames,
              }),
        })
        node.workflowName = resolved.name
        if (resolved.idHint !== undefined) node.workflowId = resolved.idHint
        delete node.workflowRef
      }
      if (typeof node.workgroupRef === 'string') {
        const resolved = await resolveCallReference({
          reader: input.reader,
          context: input.context,
          pendingNames: input.pendingNames,
          type: 'workgroup',
          wire: node.workgroupRef,
          ...(input.grandfathered === undefined
            ? {}
            : {
                grandfatheredIds: input.grandfathered.workgroupIds,
                grandfatheredNames: input.grandfathered.workgroupNames,
              }),
        })
        node.workgroupName = resolved.name
        if (resolved.idHint !== undefined) node.workgroupId = resolved.idHint
        delete node.workgroupRef
      }
      return node
    }),
  )
  return migrateWorkflowDefinitionToLatest(
    WorkflowDefinitionSchema.parse({ ...input.definition, nodes }),
  )
}

interface WorkflowGrandfatheredReferences {
  readonly agentIds: ReadonlySet<string>
  readonly workflowIds: ReadonlySet<string>
  readonly workflowNames: ReadonlySet<string>
  readonly workgroupIds: ReadonlySet<string>
  readonly workgroupNames: ReadonlySet<string>
}

function workflowGrandfatheredReferences(
  definition: ReturnType<typeof WorkflowDefinitionSchema.parse>,
): WorkflowGrandfatheredReferences {
  const agentIds = new Set<string>()
  const workflowIds = new Set<string>()
  const workflowNames = new Set<string>()
  const workgroupIds = new Set<string>()
  const workgroupNames = new Set<string>()
  for (const ref of collectWorkflowDependencyRefs(definition, {
    throwOnNullNode: true,
    allStringSelectors: true,
  })) {
    if (ref.resourceType === 'agent') agentIds.add(ref.value)
    if (ref.resourceType === 'workflow') {
      if (ref.selectorDefined !== false) workflowNames.add(ref.value)
      if (ref.idCache !== undefined) workflowIds.add(ref.idCache)
    }
    if (ref.resourceType === 'workgroup') {
      if (ref.selectorDefined !== false) workgroupNames.add(ref.value)
      if (ref.idCache !== undefined) workgroupIds.add(ref.idCache)
    }
  }
  return Object.freeze({ agentIds, workflowIds, workflowNames, workgroupIds, workgroupNames })
}

async function workflowCandidate(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly pendingNames: ReadonlyMap<string, PostgresqlResourcePackagePendingName>
  readonly mutation: WorkflowPackageMutation
  readonly grandfathered?: WorkflowGrandfatheredReferences
}): Promise<ReturnType<typeof WorkflowDraftSnapshotSchema.parse>> {
  const definition = await resolvedWorkflowDefinition({
    reader: input.reader,
    context: input.context,
    pendingNames: input.pendingNames,
    definition: input.mutation.payload.definition,
    ...(input.grandfathered === undefined ? {} : { grandfathered: input.grandfathered }),
  })
  return WorkflowDraftSnapshotSchema.parse({
    name: input.mutation.payload.name,
    description: input.mutation.payload.description,
    definition,
  })
}

export async function commitPostgresqlWorkflowPackageMutation(
  input: MutationArmInput<WorkflowPackageMutation>,
): Promise<ResourcePackageMutationReceipt<'workflow'>> {
  if (input.mutation.kind === 'workflow-create') {
    const candidate = await workflowCandidate(input)
    const now = input.now()
    await createWorkflowDefinitionWriteParticipant(input.transaction).insert(
      createWorkflowPersistenceValues({
        id: input.resourceId,
        workflow: candidate,
        ownerUserId: input.context.actor.user.id,
        now,
      }),
    )
    return receipt('workflow', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'workflow',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { workflows } = tablesOf(input.transaction)
  const row = await first(
    input.transaction
      .select()
      .from(workflows)
      .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, input.resourceId))),
  )
  if (row === undefined) {
    throw new NotFoundError('workflow-not-found', `workflow '${input.resourceId}' not found`)
  }
  const current = workflowFromPersistenceRow(row)
  const candidate = await workflowCandidate({
    ...input,
    grandfathered: workflowGrandfatheredReferences(current.definition),
  })
  const definitionStorage = serializeWorkflowDefinitionStorageV1(candidate.definition)
  const logicalSame =
    serializeWorkflowEditableSnapshotV1(workflowDraftSnapshotOf(current)) ===
    serializeWorkflowEditableSnapshotV1(candidate)
  if (!logicalSame || row.definition !== definitionStorage) {
    const changed = await first(
      createWorkflowDefinitionWriteParticipant(input.transaction).update({
        id: input.resourceId,
        expectedVersion: input.mutation.expect.expectedVersion,
        expectedAclRevision: row.aclRevision,
        ownerUserId: input.context.actor.user.id,
        builtin: false,
        set: {
          name: candidate.name,
          description: candidate.description,
          definition: definitionStorage,
          version: row.version + 1,
          updatedAt: monotonicNow(row.updatedAt),
        },
      }),
    )
    if (changed === undefined) {
      throw staleConflictError(
        'workflow',
        `workflow '${input.resourceId}' changed; reload and retry`,
      )
    }
  }
  return receipt('workflow', input.mutation, input.resourceId)
}

function humanMappingSlug(
  context: PostgresqlResourcePackageMutationRequestContext,
  mutation: WorkgroupPackageMutation,
): string | null {
  if (mutation.kind === 'workgroup-create') return mutation.slug
  const usernames = new Set(
    mutation.payload.members.flatMap((member) =>
      member.memberType === 'human' ? [member.username] : [],
    ),
  )
  if (usernames.size === 0) return null
  const bySlug = new Map<string, Set<string>>()
  for (const mapping of context.humanMemberMappings) {
    const bucket = bySlug.get(mapping.workgroupSlug)
    if (bucket === undefined) bySlug.set(mapping.workgroupSlug, new Set([mapping.username]))
    else bucket.add(mapping.username)
  }
  const matches = [...bySlug].filter(
    ([, mapped]) =>
      mapped.size === usernames.size && [...usernames].every((username) => mapped.has(username)),
  )
  if (matches.length !== 1) {
    throw new ValidationError(
      'package-human-mapping-ambiguous',
      'workgroup overwrite human mappings cannot be matched to one confirmed package entry',
    )
  }
  return matches[0]?.[0] ?? null
}

async function resolvedWorkgroupMembers(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly mutation: WorkgroupPackageMutation
  readonly grandfatheredAgentIds?: ReadonlySet<string>
}): Promise<readonly WorkgroupDraftMember[]> {
  const mappingSlug = humanMappingSlug(input.context, input.mutation)
  const mappings = new Map(
    input.context.humanMemberMappings
      .filter((mapping) => mappingSlug !== null && mapping.workgroupSlug === mappingSlug)
      .map((mapping) => [mapping.username, mapping]),
  )
  const members: WorkgroupDraftMember[] = []
  const activeUserIds = new Set<string>()
  for (const member of input.mutation.payload.members) {
    if (member.memberType === 'human') {
      const mapping = mappings.get(member.username)
      if (mapping === undefined) {
        throw new ValidationError(
          'package-human-mapping-missing',
          `no mapping for member '${member.username}'`,
        )
      }
      const userId = mapping.userId ?? null
      if (userId === null) continue
      activeUserIds.add(userId)
      members.push({
        memberType: 'human',
        userId,
        displayName: member.displayName,
        roleDesc: member.roleDesc,
      })
      continue
    }
    const agentId = await resolveIdentityReference({
      reader: input.reader,
      context: input.context,
      type: 'agent',
      wire: member.agentRef,
      ...(input.grandfatheredAgentIds === undefined
        ? {}
        : { grandfatheredIds: input.grandfatheredAgentIds }),
    })
    const { agents } = tablesOf(input.transaction)
    const agent = await first(
      input.transaction.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId)),
    )
    if (agent === undefined) {
      throw new ValidationError(
        'workgroup-member-agent-invalid',
        'agent member id(s) do not exist',
        { agentIds: [agentId] },
      )
    }
    members.push({
      memberType: 'agent',
      agentId,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    })
  }
  const active = await input.reader.findActiveUsersByIds([...activeUserIds])
  const activeIds = new Set(active.map((row) => row.userId))
  const invalid = [...activeUserIds].filter((userId) => !activeIds.has(userId))
  if (invalid.length > 0) {
    throw new ValidationError('workgroup-member-user-invalid', 'human member user(s) not active', {
      userIds: invalid,
    })
  }
  return Object.freeze(members)
}

async function workgroupMemberValues(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly workgroupId: string
  readonly members: readonly WorkgroupDraftMember[]
  readonly now: number
  readonly id: () => string
}): Promise<Array<PersistenceTables['workgroupMembers']['$inferInsert']>> {
  const agentIds = uniqueStrings(
    input.members.flatMap((member) =>
      member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
    ),
  )
  const { agents } = tablesOf(input.transaction)
  const names = new Map(
    (agentIds.length === 0
      ? []
      : await input.transaction
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds))
    ).map((row) => [row.id, row.name]),
  )
  return workgroupMemberPersistenceValues(input.workgroupId, input.members, input.now, names, () =>
    input.id(),
  )
}

async function insertWorkgroupMembers(
  transaction: PostgresqlResourceCatalogTransaction,
  values: readonly PersistenceTables['workgroupMembers']['$inferInsert'][],
): Promise<void> {
  const { workgroupMembers } = tablesOf(transaction)
  for (const value of values) await insertOne(transaction, workgroupMembers, value)
}

function currentWorkgroupSnapshot(
  row: PersistenceTables['workgroups']['$inferSelect'],
  memberRows: readonly PersistenceTables['workgroupMembers']['$inferSelect'][],
): WorkgroupDraftSnapshot {
  const current = workgroupFromRows(row, memberRows)
  const ordered = [...current.members].sort(
    (left, right) =>
      left.sortOrder - right.sortOrder || left.displayName.localeCompare(right.displayName),
  )
  const leader = ordered.find((member) => member.id === current.leaderMemberId)
  return WorkgroupDraftSnapshotSchema.parse(
    workgroupSnapshotValues(current, leader, () =>
      ordered.map((member) => {
        if (member.memberType === 'agent' && member.agentId !== null) {
          return {
            memberType: 'agent',
            agentId: member.agentId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        }
        if (member.memberType === 'human' && member.userId !== null) {
          return {
            memberType: 'human',
            userId: member.userId,
            displayName: member.displayName,
            roleDesc: member.roleDesc,
          }
        }
        throw new ValidationError(
          'workgroup-member-row-corrupt',
          `workgroup member '${member.id}' has no canonical identity`,
        )
      }),
    ),
  )
}

function workgroupCandidate(input: {
  readonly mutation: WorkgroupPackageMutation
  readonly members: readonly WorkgroupDraftMember[]
  readonly current?: WorkgroupDraftSnapshot
}): WorkgroupDraftSnapshot {
  const payload = input.mutation.payload
  const common = {
    name: payload.name,
    description: payload.description,
    instructions: payload.instructions,
    mode: payload.mode,
    outputContract:
      payload.outputContract ??
      input.current?.outputContract ??
      resolveWorkgroupOutputContract(undefined),
    ...(payload.leaderDisplayName === null ? {} : { leaderDisplayName: payload.leaderDisplayName }),
    switches: payload.switches,
    maxRounds: payload.maxRounds,
    completionGate: payload.completionGate,
    clarifyBudget:
      payload.clarifyBudget ?? input.current?.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
    fanOut: payload.fanOut ?? input.current?.fanOut ?? false,
    members: input.members,
  }
  if (input.mutation.kind === 'workgroup-create') {
    const created = CreateWorkgroupSchema.parse(common)
    return WorkgroupDraftSnapshotSchema.parse({
      ...created,
      outputContract: resolveWorkgroupOutputContract(created.outputContract),
      clarifyBudget: created.clarifyBudget ?? WG_CLARIFY_BUDGET_DEFAULT,
      fanOut: created.fanOut ?? false,
    })
  }
  return WorkgroupDraftSnapshotSchema.parse(common)
}

export async function commitPostgresqlWorkgroupPackageMutation(
  input: MutationArmInput<WorkgroupPackageMutation>,
): Promise<ResourcePackageMutationReceipt<'workgroup'>> {
  if (input.mutation.kind === 'workgroup-create') {
    const members = await resolvedWorkgroupMembers(input)
    const candidate = workgroupCandidate({ mutation: input.mutation, members })
    const { workgroups } = tablesOf(input.transaction)
    const collision = await first(
      input.transaction
        .select({ id: workgroups.id })
        .from(workgroups)
        .where(ownerScopedNameWhere(workgroups, input.context.actor.user.id, candidate.name)),
    )
    if (collision !== undefined) {
      throw new ConflictError(
        'workgroup-name-in-use',
        `workgroup '${candidate.name}' already exists`,
      )
    }
    const now = input.now()
    const memberValues = await workgroupMemberValues({
      transaction: input.transaction,
      workgroupId: input.resourceId,
      members: candidate.members,
      now,
      id: input.id,
    })
    try {
      await insertOne(input.transaction, workgroups, {
        id: input.resourceId,
        name: candidate.name,
        description: candidate.description,
        instructions: candidate.instructions,
        mode: candidate.mode,
        outputContract: resolveWorkgroupOutputContract(candidate.outputContract),
        leaderMemberId: workgroupLeaderMemberId(candidate, memberValues),
        shareOutputs: candidate.switches.shareOutputs,
        directMessages: candidate.switches.directMessages,
        blackboard: candidate.switches.blackboard,
        maxRounds: candidate.maxRounds,
        completionGate: candidate.completionGate,
        clarifyBudget: candidate.clarifyBudget,
        fanOut: candidate.fanOut,
        version: 1,
        ownerUserId: input.context.actor.user.id,
        visibility: 'private',
        aclRevision: 0,
        schemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      await insertWorkgroupMembers(input.transaction, memberValues)
    } catch (error) {
      if (isPostgresqlUniqueViolation(error, ['workgroups_owner_name_unique'])) {
        throw new ConflictError(
          'workgroup-name-in-use',
          `workgroup '${candidate.name}' already exists`,
        )
      }
      throw error
    }
    return receipt('workgroup', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'workgroup',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { workgroups, workgroupMembers } = tablesOf(input.transaction)
  const row = await first(
    input.transaction.select().from(workgroups).where(eq(workgroups.id, input.resourceId)),
  )
  if (row === undefined) {
    throw new NotFoundError('workgroup-not-found', `workgroup '${input.resourceId}' not found`)
  }
  const currentMemberRows = await input.transaction
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, input.resourceId))
  const current = currentWorkgroupSnapshot(row, currentMemberRows)
  const members = await resolvedWorkgroupMembers({
    ...input,
    grandfatheredAgentIds: new Set(
      current.members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId !== undefined ? [member.agentId] : [],
      ),
    ),
  })
  const candidate = workgroupCandidate({ mutation: input.mutation, members, current })
  const logicalSame =
    serializeWorkgroupEditableSnapshotV1(current) ===
    serializeWorkgroupEditableSnapshotV1(candidate)
  if (!logicalSame) {
    if (candidate.name !== current.name) {
      const collision = await first(
        input.transaction
          .select({ id: workgroups.id })
          .from(workgroups)
          .where(ownerScopedNameWhere(workgroups, input.context.actor.user.id, candidate.name)),
      )
      if (collision !== undefined && collision.id !== input.resourceId) {
        throw new ConflictError(
          'workgroup-name-in-use',
          `workgroup '${candidate.name}' already exists; pick a different name`,
        )
      }
    }
    const rosterChanged =
      JSON.stringify({
        leaderDisplayName: current.leaderDisplayName ?? null,
        members: current.members,
      }) !==
      JSON.stringify({
        leaderDisplayName: candidate.leaderDisplayName ?? null,
        members: candidate.members,
      })
    const now = input.now()
    const replacements = rosterChanged
      ? await workgroupMemberValues({
          transaction: input.transaction,
          workgroupId: input.resourceId,
          members: candidate.members,
          now,
          id: input.id,
        })
      : null
    const changed = await first(
      input.transaction
        .update(workgroups)
        .set({
          name: candidate.name,
          description: candidate.description,
          instructions: candidate.instructions,
          mode: candidate.mode,
          outputContract: resolveWorkgroupOutputContract(candidate.outputContract),
          leaderMemberId:
            replacements === null
              ? row.leaderMemberId
              : workgroupLeaderMemberId(candidate, replacements),
          shareOutputs: candidate.switches.shareOutputs,
          directMessages: candidate.switches.directMessages,
          blackboard: candidate.switches.blackboard,
          maxRounds: candidate.maxRounds,
          completionGate: candidate.completionGate,
          clarifyBudget: candidate.clarifyBudget,
          fanOut: candidate.fanOut,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(
          and(
            eq(workgroups.id, input.resourceId),
            eq(workgroups.version, input.mutation.expect.expectedVersion),
            eq(workgroups.ownerUserId, input.context.actor.user.id),
            eq(workgroups.aclRevision, row.aclRevision),
          ),
        )
        .returning({ id: workgroups.id }),
    )
    if (changed === undefined) {
      throw staleConflictError('workgroup', `workgroup '${input.resourceId}' changed; reload`)
    }
    if (replacements !== null) {
      await input.transaction
        .delete(workgroupMembers)
        .where(eq(workgroupMembers.workgroupId, input.resourceId))
      await insertWorkgroupMembers(input.transaction, replacements)
    }
  }
  return receipt('workgroup', input.mutation, input.resourceId)
}

export async function resolvePostgresqlCapabilityTemplatePackagePayload(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly mutation: CapabilityTemplatePackageMutation
}): Promise<Readonly<Record<string, unknown>>> {
  const payload = Object.fromEntries(Object.entries(input.mutation.payload))
  if (
    input.mutation.kind === 'capability-binding-create' ||
    input.mutation.kind === 'capability-binding-update'
  ) {
    payload.frameworkId = await resolveIdentityReference({
      reader: input.reader,
      context: input.context,
      type: 'capability_template',
      wire: input.mutation.payload.frameworkRef,
    })
    delete payload.frameworkRef
  }
  if (
    input.mutation.kind === 'capability-binding-create' ||
    input.mutation.kind === 'capability-binding-update' ||
    input.mutation.kind === 'capability-template-create' ||
    input.mutation.kind === 'capability-template-update'
  ) {
    const resolved: Record<string, string> = {}
    for (const [slot, wire] of Object.entries(input.mutation.payload.agentBySlot)) {
      resolved[slot] = await resolveIdentityReference({
        reader: input.reader,
        context: input.context,
        type: 'agent',
        wire,
      })
    }
    payload.agentBySlot = resolved
  }
  return Object.freeze(payload)
}

export async function assertPostgresqlCapabilityTemplatePackageOverwrite(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly mutation: CapabilityTemplatePackageMutation
  readonly resourceId: string
}): Promise<void> {
  await assertOwnedOverwrite({ ...input, type: 'capability_template' })
}
