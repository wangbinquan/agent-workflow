import { createWorkflowMutationParticipant } from '../workflowMutationParticipant'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type {
  ResourcePackageSkillPublication as PostgresqlResourcePackageSkillPublication,
  ResourcePackagePluginPublication as PostgresqlResourcePackagePluginPublication,
} from '../../application/package/artifactOwners'
export type {
  ResourcePackageSkillPublication as PostgresqlResourcePackageSkillPublication,
  ResourcePackagePluginPublication as PostgresqlResourcePackagePluginPublication,
} from '../../application/package/artifactOwners'
import { workgroupCreateSnapshot } from '../workgroupPersistence'
import {
  collectWorkflowDependencyRefs,
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
  type AgentSkillRef,
  type AclResourceType,
  type BundleResourceType,
  type CreateAgent,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { NotFoundError, ValidationError } from '@/util/errors'
import type { McpTransactionLifecycle } from '../mcpRepository'
import { type PostgresqlResourceCatalogTransaction } from '../postgresql/repositorySupport'

import { createWorkgroupMutationParticipant } from '../workgroupMutationParticipant'
import {
  type AgentPackageMutation,
  type CapabilityTemplatePackageMutation,
  type McpPackageMutation,
  type PluginPackageMutation,
  type ResourcePackageMutationReceipt,
  type SkillPackageMutation,
  type WorkflowPackageMutation,
  type WorkgroupPackageMutation,
} from '../../public/types'

import type {
  PostgresqlResourcePackageMutationRequestContext,
  PostgresqlResourcePackageTransactionReader,
} from './postgresqlResourcePackageMutationParticipants'
import type { AgentMutationBatch } from '../../application/ports/agentMutation'
import { createAgentMutationParticipant } from '../agentMutationParticipant'
import { createSkillMutationParticipant } from '../skillMutationParticipant'
import { createMcpMutationParticipant } from '../mcpMutationParticipant'
import { createPluginMutationParticipant } from '../pluginMutationParticipant'

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

/**
 * RFC-401 A1 —— agent 载荷里的一条 identity 引用解析为 id。只做场景解析：`local:` 指向本包新建的资源
 * （`bundle-ref-invalid`），`builtin:` 按名称找内建资源（`bundle-builtin-missing`）；`external:` 只解码为 id，存在与可见
 * 由唯一的 agent 写入参与者按普通编辑的判据报（不再报 `package-external-unresolved`）。
 */
async function agentReferenceId(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly type: BundleResourceType
  readonly wire: string
}): Promise<string> {
  const decoded = decodeBundleIdentityRef(input.wire)
  if (decoded === null) throw invalidReference(input.type, input.wire)
  if (decoded.k === 'local') {
    const resourceId = input.context.ids.findCreate({ type: input.type, localSlug: decoded.slug })
    if (resourceId === null) throw invalidReference(input.type, input.wire)
    return resourceId
  }
  if (decoded.k === 'external') return decoded.token
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

async function agentSkillReference(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly wire: string
}): Promise<AgentSkillRef> {
  const decoded = decodeBundleAgentSkillRef(input.wire)
  if (decoded === null) throw invalidReference('skill', input.wire)
  if (decoded.k === 'project-skill') return { kind: 'project', name: decoded.name }
  return {
    kind: 'managed',
    skillId: await agentReferenceId({
      reader: input.reader,
      context: input.context,
      type: 'skill',
      wire: input.wire,
    }),
  }
}

/** 包内的 agent 定义解析为引用已是 id 的 CreateAgent；规范化（含去重）由写入参与者做。 */
async function resolvedAgentInput(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly mutation: AgentPackageMutation
}): Promise<CreateAgent> {
  const payload = input.mutation.payload
  const ids = (type: 'agent' | 'mcp' | 'plugin', wires: readonly string[]) =>
    Promise.all(
      wires.map((wire) =>
        agentReferenceId({ reader: input.reader, context: input.context, type, wire }),
      ),
    )
  return CreateAgentSchema.parse({
    ...payload,
    skills: await Promise.all(
      payload.skills.map((wire) =>
        agentSkillReference({ reader: input.reader, context: input.context, wire }),
      ),
    ),
    dependsOn: await ids('agent', payload.dependsOn),
    mcp: await ids('mcp', payload.mcp),
    plugins: await ids('plugin', payload.plugins),
  })
}

/**
 * 本包的 agent 及其最终 dependsOn（RFC-401 A1 的批内事实）。宽松解析：解析不了的引用跳过，留给该条 op 自己的解析
 * 按场景次序报错；本包新建的 managed skill 提交后才发布，闭包校验视为可用。
 */
export async function resourcePackageAgentBatch(input: {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly agents: readonly Readonly<{ mutation: AgentPackageMutation; resourceId: string }>[]
}): Promise<AgentMutationBatch> {
  const dependencies = new Map<string, readonly string[]>()
  for (const agent of input.agents) {
    const resolved: string[] = []
    for (const wire of agent.mutation.payload.dependsOn) {
      try {
        resolved.push(
          await agentReferenceId({
            reader: input.reader,
            context: input.context,
            type: 'agent',
            wire,
          }),
        )
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error
      }
    }
    dependencies.set(agent.resourceId, Object.freeze(resolved))
  }
  const stagedSkillIds = new Set(
    input.context.ids
      .listPending()
      .filter((pending) => pending.type === 'skill')
      .map((pending) => pending.resourceId),
  )
  return Object.freeze({
    pendingDependencies: (id: string) => dependencies.get(id),
    stagedSkillIds,
  })
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
  input: MutationArmInput<AgentPackageMutation> & { readonly batch: AgentMutationBatch },
): Promise<ResourcePackageMutationReceipt<'agent'>> {
  const agents = createAgentMutationParticipant(input.transaction, { now: input.now })
  const owner = Object.freeze({ kind: 'actor' as const, actor: input.context.actor })
  const mutation = input.mutation
  if (mutation.kind === 'agent-create') {
    await agents.create(owner, {
      id: input.resourceId,
      agent: await resolvedAgentInput({
        reader: input.reader,
        context: input.context,
        mutation,
      }),
      batch: input.batch,
    })
    return receipt('agent', mutation, input.resourceId)
  }

  // 场景基线先于资源层：已选目标消失 / 变化、非本人所有、builtin 只读（proposal §5 第 11 项）。
  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'agent',
    resourceId: input.resourceId,
    mutation,
  })
  await agents.update(owner, {
    id: input.resourceId,
    fence: {
      expectedUpdatedAt: mutation.expect.expectedUpdatedAt,
      expectedAclRevision: mutation.expect.expectedAclRevision,
    },
    async patch() {
      const { name: _name, ...updateBody } = await resolvedAgentInput({
        reader: input.reader,
        context: input.context,
        mutation,
      })
      return UpdateAgentSchema.parse(updateBody)
    },
    batch: input.batch,
  })
  return receipt('agent', mutation, input.resourceId)
}

export async function commitPostgresqlSkillPackageMutation(
  input: SkillMutationArmInput,
): Promise<ResourcePackageMutationReceipt<'skill'>> {
  const parsed = CreateManagedSkillSchema.parse(input.mutation.payload)
  const skillWrites = createSkillMutationParticipant(input.transaction)
  const contentKind = input.contentKind ?? input.publication.contentKind ?? 'local-file'
  if (input.mutation.kind === 'skill-create') {
    await skillWrites.create({
      id: input.resourceId,
      name: parsed.name,
      description: parsed.description,
      ownerUserId: input.context.actor.user.id,
      contentKind,
      contentHash: input.publication.contentHash,
      livePath: input.publication.managedPath,
      versionPath: input.publication.filesPath,
      authorUserId: input.context.actor.user.id,
      now: input.now(),
    })
    return receipt('skill', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'skill',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  const { skills } = tablesOf(input.transaction)
  const row = await first(
    input.transaction
      .select({ reservationState: skills.reservationState })
      .from(skills)
      .where(eq(skills.id, input.resourceId)),
  )
  if (row === undefined || row.reservationState !== 'ready') {
    throw new NotFoundError('skill-not-found', `skill '${input.resourceId}' not found`)
  }
  await skillWrites.version({
    skillId: input.resourceId,
    versionIndex: input.mutation.expect.expectedContentVersion + 1,
    contentKind,
    contentHash: input.publication.contentHash,
    livePath: input.publication.managedPath,
    versionPath: input.publication.filesPath,
    fence: {
      expectedVersion: input.mutation.expect.expectedContentVersion,
      expectedMetaRevision: input.mutation.expect.expectedMetaRevision,
      expectedAclRevision: input.mutation.expect.expectedAclRevision,
      expectedOwnerUserId: input.context.actor.user.id,
      staleMessage: `skill '${input.resourceId}' changed; reload and retry`,
    },
    source: 'import',
    summary: null,
    fusionId: null,
    restoredFromVersion: null,
    authorUserId: input.context.actor.user.id,
    description: parsed.description,
    now: input.now(),
  })
  return receipt('skill', input.mutation, input.resourceId)
}

export async function commitPostgresqlMcpPackageMutation(
  input: MutationArmInput<McpPackageMutation> & {
    readonly lifecycle: McpTransactionLifecycle
  },
): Promise<ResourcePackageMutationReceipt<'mcp'>> {
  const mcps = createMcpMutationParticipant(input.transaction, {
    lifecycle: input.lifecycle,
    now: input.now,
  })
  const mutation = input.mutation
  if (mutation.kind === 'mcp-create') {
    await mcps.create({
      id: input.resourceId,
      ownerUserId: input.context.actor.user.id,
      input: CreateMcpSchema.parse(mutation.payload),
    })
    return receipt('mcp', mutation, input.resourceId)
  }

  // 场景基线先于资源层：已选目标消失 / 变化、非本人所有、builtin 只读（proposal §5 第 11 项）。
  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'mcp',
    resourceId: input.resourceId,
    mutation,
  })
  const { name: _name, ...updateBody } = mutation.payload
  const patch = UpdateMcpSchema.parse(updateBody)
  await mcps.update({
    id: input.resourceId,
    expectedConfigHash: mutation.expect.expectedConfigHash,
    patch: () => patch,
  })
  return receipt('mcp', mutation, input.resourceId)
}

export async function commitPostgresqlPluginPackageMutation(
  input: MutationArmInput<PluginPackageMutation> & {
    /** 本次的新安装；规格不变的覆盖在事务前不安装（proposal §5 第 10 项），为 undefined。 */
    readonly publication: PostgresqlResourcePackagePluginPublication | undefined
  },
): Promise<ResourcePackageMutationReceipt<'plugin'>> {
  const plugins = createPluginMutationParticipant(input.transaction, { now: input.now })
  const mutation = input.mutation
  const parsed = CreatePluginSchema.parse(mutation.payload)
  if (mutation.kind === 'plugin-create') {
    if (input.publication === undefined) throw new Error('resource-package-plugin-install-missing')
    await plugins.create({
      id: input.resourceId,
      ownerUserId: input.context.actor.user.id,
      input: {
        name: parsed.name,
        spec: parsed.spec,
        options: parsed.options,
        description: parsed.description,
        enabled: parsed.enabled,
      },
      installation: input.publication,
    })
    return receipt('plugin', mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'plugin',
    resourceId: input.resourceId,
    mutation,
  })
  const { name: _name, sourceKind: _sourceKind, ...updateBody } = mutation.payload
  const patch = UpdatePluginSchema.parse(updateBody)
  await plugins.update({
    id: input.resourceId,
    expectedConfigHash: mutation.expect.expectedConfigHash,
    patch: () => patch,
    installation: input.publication ?? null,
  })
  return receipt('plugin', mutation, input.resourceId)
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

/** 本包新建的 workflow / workgroup 名称：按名字调用它们视为可见（被调方可能在本包稍后才写入）。 */
function packageCreatedNames(
  pendingNames: ReadonlyMap<string, PostgresqlResourcePackagePendingName>,
): Readonly<{ workflow: ReadonlySet<string>; workgroup: ReadonlySet<string> }> {
  const workflow = new Set<string>()
  const workgroup = new Set<string>()
  for (const pending of pendingNames.values()) {
    if (pending.type === 'workflow') workflow.add(pending.name)
    if (pending.type === 'workgroup') workgroup.add(pending.name)
  }
  return Object.freeze({ workflow, workgroup })
}

/**
 * RFC-401 A3：workflow 经唯一的写入参与者写入（design §9.4）。资源包只保留自己的规则：包内引用解析（覆盖时按当前定义
 * 保留历史引用）与已选基线（`assertOwnedOverwrite`）。
 */
export async function commitPostgresqlWorkflowPackageMutation(
  input: MutationArmInput<WorkflowPackageMutation>,
): Promise<ResourcePackageMutationReceipt<'workflow'>> {
  const workflows = createWorkflowMutationParticipant(input.transaction, { now: input.now })
  const owner = { kind: 'actor', actor: input.context.actor } as const
  const batch = Object.freeze({ createdNames: packageCreatedNames(input.pendingNames) })
  if (input.mutation.kind === 'workflow-create') {
    const candidate = await workflowCandidate(input)
    await workflows.create(owner, { id: input.resourceId, content: candidate, batch })
    return receipt('workflow', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'workflow',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  await workflows.update(owner, {
    id: input.resourceId,
    expectedVersion: input.mutation.expect.expectedVersion,
    patch: (current) =>
      workflowCandidate({
        ...input,
        grandfathered: workflowGrandfatheredReferences(current.definition),
      }),
    batch,
  })
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
    members.push({
      memberType: 'agent',
      agentId,
      displayName: member.displayName,
      roleDesc: member.roleDesc,
    })
  }
  return Object.freeze(members)
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
    return workgroupCreateSnapshot(CreateWorkgroupSchema.parse(common))
  }
  return WorkgroupDraftSnapshotSchema.parse(common)
}

/**
 * RFC-401 A3b：workgroup 经唯一的写入参与者写入（design §9.5）。资源包只保留自己的规则：人类成员映射与包内引用解析（覆盖时
 * 沿用当前成员的 agent 引用）、已选基线（`assertOwnedOverwrite`）。
 */
export async function commitPostgresqlWorkgroupPackageMutation(
  input: MutationArmInput<WorkgroupPackageMutation>,
): Promise<ResourcePackageMutationReceipt<'workgroup'>> {
  const workgroups = createWorkgroupMutationParticipant(input.transaction, {
    now: input.now,
    memberId: input.id,
  })
  if (input.mutation.kind === 'workgroup-create') {
    const members = await resolvedWorkgroupMembers(input)
    await workgroups.create(input.context.actor, {
      id: input.resourceId,
      snapshot: workgroupCandidate({ mutation: input.mutation, members }),
    })
    return receipt('workgroup', input.mutation, input.resourceId)
  }

  await assertOwnedOverwrite({
    reader: input.reader,
    context: input.context,
    type: 'workgroup',
    resourceId: input.resourceId,
    mutation: input.mutation,
  })
  await workgroups.update(input.context.actor, {
    id: input.resourceId,
    expectedVersion: input.mutation.expect.expectedVersion,
    patch: async (_current, currentSnapshot) => {
      const members = await resolvedWorkgroupMembers({
        ...input,
        grandfatheredAgentIds: new Set(
          currentSnapshot.members.flatMap((member) =>
            member.memberType === 'agent' && member.agentId !== undefined ? [member.agentId] : [],
          ),
        ),
      })
      return workgroupCandidate({ mutation: input.mutation, members, current: currentSnapshot })
    },
  })
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
