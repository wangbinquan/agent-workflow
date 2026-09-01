import { decodeBundleIdentityRef, type ResourceVisibility } from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import {
  agents,
  capabilityTemplates,
  mcps,
  plugins,
  resourceGrants,
  skills,
  users,
  workflows,
  workgroups,
} from '@/db/schema'
import { ConflictError, ValidationError } from '@/util/errors'
import type {
  ResourcePackageHumanMemberMapping,
  ResourcePackageImportDecision,
  ResourcePackageSecretInput,
} from '../../application/package/ports'
import type { ResourceCurrentAuthorityResolver } from '../../application/participants/resourceAuthorization'
import { canViewAccess, resolveResourceAccess } from '../../domain/resourceAccess'
import type { PackageResourceKind } from '../../domain/resourceKinds'
import type { ResourceRequestContext } from '../../public/participants'
import {
  assertTrustedResourcePackageCapability,
  createPreparedAgentPackageMutation,
  createPreparedCapabilityTemplatePackageMutation,
  createPreparedMcpPackageMutation,
  createPreparedPluginPackageMutation,
  createPreparedSkillPackageMutation,
  createPreparedWorkflowPackageMutation,
  createPreparedWorkgroupPackageMutation,
} from '../../application/participants/resourcePackageCapabilities'
import type {
  AgentPackageMutation,
  CapabilityTemplatePackageMutation,
  McpPackageMutation,
  PluginPackageMutation,
  PreparedAgentPackageMutation,
  PreparedCapabilityTemplatePackageMutation,
  PreparedMcpPackageMutation,
  PreparedPackageMutation,
  PreparedPluginPackageMutation,
  PreparedSkillPackageMutation,
  PreparedWorkflowPackageMutation,
  PreparedWorkgroupPackageMutation,
  ResourcePackageMutationReceipt,
  SkillPackageMutation,
  WorkflowPackageMutation,
  WorkgroupPackageMutation,
} from '../../public/types'
import { mcpConfigHash, mcpFromPersistenceRow } from '../mcpPersistence'
import { pluginConfigHash, pluginFromPersistenceRow } from '../pluginPersistence'
import type { PostgresqlMcpTransactionLifecycle } from '../postgresqlMcpRepository'
import type { PostgresqlResourceCatalogTransaction } from '../postgresql/repositorySupport'
import {
  assertPostgresqlCapabilityTemplatePackageOverwrite,
  commitPostgresqlAgentPackageMutation,
  commitPostgresqlMcpPackageMutation,
  commitPostgresqlPluginPackageMutation,
  commitPostgresqlSkillPackageMutation,
  commitPostgresqlWorkflowPackageMutation,
  commitPostgresqlWorkgroupPackageMutation,
  resolvePostgresqlCapabilityTemplatePackagePayload,
  type PostgresqlResourcePackagePendingName,
  type PostgresqlResourcePackagePluginPublication,
  type PostgresqlResourcePackageSkillPublication,
} from './postgresqlResourcePackageMutationArms'

export type PostgresqlResourcePackageSelectionFence =
  | Readonly<{
      kind: 'agent-revision'
      expectedUpdatedAt: number
      expectedAclRevision: number
    }>
  | Readonly<{
      kind: 'skill-revision'
      expectedContentVersion: number
      expectedMetaRevision: number
      expectedAclRevision: number
    }>
  | Readonly<{ kind: 'mcp-config'; expectedConfigHash: string }>
  | Readonly<{ kind: 'plugin-config'; expectedConfigHash: string }>
  | Readonly<{ kind: 'workflow-version'; expectedVersion: number }>
  | Readonly<{ kind: 'workgroup-version'; expectedVersion: number }>
  | Readonly<{
      kind: 'capability-template-revision'
      expectedUpdatedAt: number
      expectedAclRevision: number
    }>

interface PostgresqlResourcePackageResourceBase {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly builtin: boolean
}

export type PostgresqlResourcePackageResource =
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'agent'
        fence: Extract<PostgresqlResourcePackageSelectionFence, { kind: 'agent-revision' }>
      }
    >
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'skill'
        fence: Extract<PostgresqlResourcePackageSelectionFence, { kind: 'skill-revision' }>
      }
    >
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'mcp'
        fence: Extract<PostgresqlResourcePackageSelectionFence, { kind: 'mcp-config' }>
      }
    >
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'plugin'
        fence: Extract<PostgresqlResourcePackageSelectionFence, { kind: 'plugin-config' }>
      }
    >
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'workflow'
        fence: Extract<PostgresqlResourcePackageSelectionFence, { kind: 'workflow-version' }>
      }
    >
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'workgroup'
        fence: Extract<PostgresqlResourcePackageSelectionFence, { kind: 'workgroup-version' }>
      }
    >
  | Readonly<
      PostgresqlResourcePackageResourceBase & {
        type: 'capability_template'
        fence: Extract<
          PostgresqlResourcePackageSelectionFence,
          { kind: 'capability-template-revision' }
        >
      }
    >

export interface PostgresqlResourcePackageActiveUser {
  readonly username: string
  readonly userId: string
}

export interface PostgresqlResourcePackageActiveUserId {
  readonly userId: string
}

type PostgresqlResourcePackageSelectionInput<
  TType extends PackageResourceKind,
  TFence extends PostgresqlResourcePackageSelectionFence,
> = Readonly<{
  action: 'reuse' | 'overwrite'
  type: TType
  id: string
  fence: TFence
}>

export type PostgresqlResourcePackageSelectedResource =
  | PostgresqlResourcePackageSelectionInput<
      'agent',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'agent-revision' }>
    >
  | PostgresqlResourcePackageSelectionInput<
      'skill',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'skill-revision' }>
    >
  | PostgresqlResourcePackageSelectionInput<
      'mcp',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'mcp-config' }>
    >
  | PostgresqlResourcePackageSelectionInput<
      'plugin',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'plugin-config' }>
    >
  | PostgresqlResourcePackageSelectionInput<
      'workflow',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'workflow-version' }>
    >
  | PostgresqlResourcePackageSelectionInput<
      'workgroup',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'workgroup-version' }>
    >
  | PostgresqlResourcePackageSelectionInput<
      'capability_template',
      Extract<PostgresqlResourcePackageSelectionFence, { kind: 'capability-template-revision' }>
    >

export interface PostgresqlResourcePackageTransactionReader {
  getById(type: PackageResourceKind, id: string): Promise<PostgresqlResourcePackageResource | null>
  findBuiltin(
    type: PackageResourceKind,
    name: string,
  ): Promise<PostgresqlResourcePackageResource | null>
  assertVisible(type: PackageResourceKind, id: string): Promise<PostgresqlResourcePackageResource>
  assertSelected(
    input: PostgresqlResourcePackageSelectedResource,
  ): Promise<PostgresqlResourcePackageResource>
  findActiveUsers(
    usernames: readonly string[],
  ): Promise<readonly PostgresqlResourcePackageActiveUser[]>
  findActiveUsersByIds(
    userIds: readonly string[],
  ): Promise<readonly PostgresqlResourcePackageActiveUserId[]>
}

function resourceBase(row: {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: ResourceVisibility
  readonly builtin?: boolean
}): PostgresqlResourcePackageResourceBase {
  return Object.freeze({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    visibility: row.visibility,
    builtin: row.builtin === true,
  })
}

async function getResourceById(
  transaction: PostgresqlResourceCatalogTransaction,
  type: PackageResourceKind,
  id: string,
): Promise<PostgresqlResourcePackageResource | null> {
  switch (type) {
    case 'agent': {
      const row = await transaction.select().from(agents).where(eq(agents.id, id)).get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({
              kind: 'agent-revision',
              expectedUpdatedAt: row.updatedAt,
              expectedAclRevision: row.aclRevision,
            }),
          })
    }
    case 'skill': {
      const row = await transaction.select().from(skills).where(eq(skills.id, id)).get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({
              kind: 'skill-revision',
              expectedContentVersion: row.contentVersion,
              expectedMetaRevision: row.metaRevision,
              expectedAclRevision: row.aclRevision,
            }),
          })
    }
    case 'mcp': {
      const row = await transaction.select().from(mcps).where(eq(mcps.id, id)).get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({
              kind: 'mcp-config',
              expectedConfigHash: mcpConfigHash(mcpFromPersistenceRow(row)),
            }),
          })
    }
    case 'plugin': {
      const row = await transaction.select().from(plugins).where(eq(plugins.id, id)).get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({
              kind: 'plugin-config',
              expectedConfigHash: pluginConfigHash(pluginFromPersistenceRow(row)),
            }),
          })
    }
    case 'workflow': {
      const row = await transaction.select().from(workflows).where(eq(workflows.id, id)).get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({ kind: 'workflow-version', expectedVersion: row.version }),
          })
    }
    case 'workgroup': {
      const row = await transaction.select().from(workgroups).where(eq(workgroups.id, id)).get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({ kind: 'workgroup-version', expectedVersion: row.version }),
          })
    }
    case 'capability_template': {
      const row = await transaction
        .select()
        .from(capabilityTemplates)
        .where(eq(capabilityTemplates.id, id))
        .get()
      return row === undefined
        ? null
        : Object.freeze({
            ...resourceBase(row),
            type,
            fence: Object.freeze({
              kind: 'capability-template-revision',
              expectedUpdatedAt: row.updatedAt,
              expectedAclRevision: row.aclRevision,
            }),
          })
    }
  }
}

async function findBuiltinResource(
  transaction: PostgresqlResourceCatalogTransaction,
  type: PackageResourceKind,
  name: string,
): Promise<PostgresqlResourcePackageResource | null> {
  let id: string | undefined
  switch (type) {
    case 'agent':
      id = (
        await transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.name, name), eq(agents.builtin, true)))
          .get()
      )?.id
      break
    case 'workflow':
      id = (
        await transaction
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.name, name), eq(workflows.builtin, true)))
          .get()
      )?.id
      break
    case 'capability_template':
      id = (
        await transaction
          .select({ id: capabilityTemplates.id })
          .from(capabilityTemplates)
          .where(and(eq(capabilityTemplates.name, name), eq(capabilityTemplates.builtin, true)))
          .get()
      )?.id
      break
    case 'skill':
    case 'mcp':
    case 'plugin':
    case 'workgroup':
      return null
  }
  return id === undefined ? null : getResourceById(transaction, type, id)
}

function fenceMatches(
  current: PostgresqlResourcePackageSelectionFence,
  expected: PostgresqlResourcePackageSelectionFence,
): boolean {
  if (current.kind !== expected.kind) return false
  switch (current.kind) {
    case 'agent-revision':
      return (
        expected.kind === current.kind &&
        current.expectedUpdatedAt === expected.expectedUpdatedAt &&
        current.expectedAclRevision === expected.expectedAclRevision
      )
    case 'skill-revision':
      return (
        expected.kind === current.kind &&
        current.expectedContentVersion === expected.expectedContentVersion &&
        current.expectedMetaRevision === expected.expectedMetaRevision &&
        current.expectedAclRevision === expected.expectedAclRevision
      )
    case 'mcp-config':
    case 'plugin-config':
      return (
        expected.kind === current.kind && current.expectedConfigHash === expected.expectedConfigHash
      )
    case 'workflow-version':
    case 'workgroup-version':
      return expected.kind === current.kind && current.expectedVersion === expected.expectedVersion
    case 'capability-template-revision':
      return (
        expected.kind === current.kind &&
        current.expectedUpdatedAt === expected.expectedUpdatedAt &&
        current.expectedAclRevision === expected.expectedAclRevision
      )
  }
}

export function bindPostgresqlResourcePackageTransactionReader(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: Actor,
): PostgresqlResourcePackageTransactionReader {
  async function visibleResource(
    type: PackageResourceKind,
    id: string,
  ): Promise<PostgresqlResourcePackageResource | null> {
    const resource = await getResourceById(transaction, type, id)
    if (resource === null) return null
    const grant = await transaction
      .select({ level: resourceGrants.level })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, type),
          eq(resourceGrants.resourceId, id),
          eq(resourceGrants.userId, actor.user.id),
        ),
      )
      .get()
    return canViewAccess(resolveResourceAccess(actor, resource, grant?.level ?? null))
      ? resource
      : null
  }

  async function assertVisible(
    type: PackageResourceKind,
    id: string,
  ): Promise<PostgresqlResourcePackageResource> {
    const resource = await visibleResource(type, id)
    if (resource === null) {
      throw new ValidationError(
        'package-external-unresolved',
        `referenced ${type} '${id}' is not available on this instance`,
      )
    }
    return resource
  }

  const reader: PostgresqlResourcePackageTransactionReader = {
    getById: (type, id) => getResourceById(transaction, type, id),
    findBuiltin: (type, name) => findBuiltinResource(transaction, type, name),
    assertVisible,
    async assertSelected(input) {
      const resource = await visibleResource(input.type, input.id)
      if (resource === null) {
        throw new ConflictError(
          'package-selected-target-gone',
          `the ${input.type} you chose to ${input.action} is no longer available`,
        )
      }
      if (!fenceMatches(resource.fence, input.fence)) {
        throw new ConflictError(
          'package-selected-target-changed',
          `the ${input.type} you chose to ${input.action} changed since the preview; re-run the preview`,
        )
      }
      return resource
    },
    async findActiveUsers(usernames) {
      if (usernames.length === 0) return []
      const rows = await transaction
        .select({ id: users.id, username: users.username, status: users.status })
        .from(users)
        .where(inArray(users.username, [...new Set(usernames)]))
        .all()
      return rows
        .filter((row) => row.status === 'active')
        .map((row) => Object.freeze({ username: row.username, userId: row.id }))
    },
    async findActiveUsersByIds(userIds) {
      const requested = [...new Set(userIds)]
      if (requested.length === 0) return []
      const rows = await transaction
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, requested), eq(users.status, 'active')))
        .all()
      const active = new Set(rows.map((row) => row.id))
      return requested.flatMap((userId) => (active.has(userId) ? [Object.freeze({ userId })] : []))
    },
  }
  return Object.freeze(reader)
}

export interface PostgresqlResourcePackagePendingResourceId {
  readonly type: PackageResourceKind
  readonly localSlug: string
  readonly resourceId: string
}

export interface PostgresqlResourcePackageRequestIds {
  mintCreate(input: { readonly type: PackageResourceKind; readonly localSlug: string }): string
  findCreate(input: {
    readonly type: PackageResourceKind
    readonly localSlug: string
  }): string | null
  listPending(): readonly PostgresqlResourcePackagePendingResourceId[]
}

export interface PostgresqlResourcePackageMutationRequestContext {
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
  readonly secretInputs: readonly ResourcePackageSecretInput[]
  readonly readSkillFile?: (ref: string) => Uint8Array
  readonly ids: PostgresqlResourcePackageRequestIds
}

export interface PostgresqlResourcePackageMutationSessionCreateInput {
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
  readonly secretInputs: readonly ResourcePackageSecretInput[]
  readonly readSkillFile?: (ref: string) => Uint8Array
}

interface PostgresqlResourcePackagePreparationParticipant<TMutation, TPrepared> {
  prepareOpaque(mutation: TMutation): Promise<TPrepared>
}

interface PostgresqlResourcePackageTransactionParticipant<
  TPrepared,
  TResourceType extends ResourcePackageMutationReceipt['resourceType'],
> {
  commit(prepared: TPrepared): Promise<ResourcePackageMutationReceipt<TResourceType>>
}

export interface PostgresqlResourcePackagePreparationParticipants {
  readonly agents: PostgresqlResourcePackagePreparationParticipant<
    AgentPackageMutation,
    PreparedAgentPackageMutation
  >
  readonly skills: PostgresqlResourcePackagePreparationParticipant<
    SkillPackageMutation,
    PreparedSkillPackageMutation
  >
  readonly mcps: PostgresqlResourcePackagePreparationParticipant<
    McpPackageMutation,
    PreparedMcpPackageMutation
  >
  readonly plugins: PostgresqlResourcePackagePreparationParticipant<
    PluginPackageMutation,
    PreparedPluginPackageMutation
  >
  readonly workflows: PostgresqlResourcePackagePreparationParticipant<
    WorkflowPackageMutation,
    PreparedWorkflowPackageMutation
  >
  readonly workgroups: PostgresqlResourcePackagePreparationParticipant<
    WorkgroupPackageMutation,
    PreparedWorkgroupPackageMutation
  >
  readonly capabilityTemplates: PostgresqlResourcePackagePreparationParticipant<
    CapabilityTemplatePackageMutation,
    PreparedCapabilityTemplatePackageMutation
  >
}

export interface PostgresqlResourcePackageTransactionParticipants {
  readonly agents: PostgresqlResourcePackageTransactionParticipant<
    PreparedAgentPackageMutation,
    'agent'
  >
  readonly skills: PostgresqlResourcePackageTransactionParticipant<
    PreparedSkillPackageMutation,
    'skill'
  >
  readonly mcps: PostgresqlResourcePackageTransactionParticipant<PreparedMcpPackageMutation, 'mcp'>
  readonly plugins: PostgresqlResourcePackageTransactionParticipant<
    PreparedPluginPackageMutation,
    'plugin'
  >
  readonly workflows: PostgresqlResourcePackageTransactionParticipant<
    PreparedWorkflowPackageMutation,
    'workflow'
  >
  readonly workgroups: PostgresqlResourcePackageTransactionParticipant<
    PreparedWorkgroupPackageMutation,
    'workgroup'
  >
  readonly capabilityTemplates: PostgresqlResourcePackageTransactionParticipant<
    PreparedCapabilityTemplatePackageMutation,
    'capability_template'
  >
}

export interface PostgresqlResourcePackageTransactionSession {
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly participants: PostgresqlResourcePackageTransactionParticipants
}

/** Durable, JSON-safe record written before each plugin/skill side effect. */
export type PostgresqlResourcePackageMutationArtifact =
  | Readonly<{
      kind: 'plugin-install'
      operationId: string
      pluginId: string
      generationId: string
      generationDirectory: string
    }>
  | Readonly<{
      kind: 'skill-stage'
      operationId: string
      skillId: string
      stagingDirectory: string
      targetDirectory: string
    }>
  | Readonly<{
      kind: 'skill-version-stage'
      operationId: string
      skillId: string
      publishId: string
      version: number
      stagingDirectory: string
      versionDirectory: string
    }>

export type PostgresqlResourcePackagePluginArtifact = Extract<
  PostgresqlResourcePackageMutationArtifact,
  { kind: 'plugin-install' }
>

export type PostgresqlResourcePackageSkillArtifact = Extract<
  PostgresqlResourcePackageMutationArtifact,
  { kind: 'skill-stage' | 'skill-version-stage' }
>

export interface PostgresqlResourcePackagePluginInstallPlan {
  /** Planning is side-effect free; install may run only after artifact persistence. */
  readonly artifact: PostgresqlResourcePackagePluginArtifact
  install(): Promise<PostgresqlResourcePackagePluginPublication>
}

export interface PostgresqlResourcePackagePluginArtifactOwner {
  planInstall(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      mutation: PluginPackageMutation
      pluginId: string
      generationId: string
    }>,
  ): PostgresqlResourcePackagePluginInstallPlan
  compensate(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      artifact: PostgresqlResourcePackagePluginArtifact
      databaseCommitted: boolean
    }>,
  ): Promise<void>
  rollForward(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      artifact: PostgresqlResourcePackagePluginArtifact
      receipt: PostgresqlResourcePackageApplyReceipt
    }>,
  ): Promise<void>
  afterCommitted(
    context: PostgresqlResourcePackageMutationRequestContext,
    receipt: PostgresqlResourcePackageApplyReceipt,
  ): Promise<void>
}

export interface PostgresqlResourcePackageSkillStagePlan {
  /** Planning is side-effect free; stage may run only after artifact persistence. */
  readonly artifact: PostgresqlResourcePackageSkillArtifact
  stage(): Promise<PostgresqlResourcePackageSkillPublication>
}

export interface PostgresqlResourcePackageSkillArtifactOwner {
  planCreate(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      mutation: Extract<SkillPackageMutation, { kind: 'skill-create' }>
      skillId: string
    }>,
  ): PostgresqlResourcePackageSkillStagePlan
  planUpdate(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      mutation: Extract<SkillPackageMutation, { kind: 'skill-update' }>
      skillId: string
      publishId: string
      version: number
    }>,
  ): PostgresqlResourcePackageSkillStagePlan
  compensate(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      artifact: PostgresqlResourcePackageSkillArtifact
      databaseCommitted: boolean
    }>,
  ): Promise<void>
  rollForward(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      artifact: PostgresqlResourcePackageSkillArtifact
      receipt: PostgresqlResourcePackageApplyReceipt
    }>,
  ): Promise<void>
  afterCommitted(
    context: PostgresqlResourcePackageMutationRequestContext,
    receipt: PostgresqlResourcePackageApplyReceipt,
  ): Promise<void>
}

/** Capability-template persistence remains owned by its native aggregate. */
export interface PostgresqlCapabilityTemplatePackageMutationOwner {
  prepareOwnerNative(
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      mutation: CapabilityTemplatePackageMutation
      resourceId: string
    }>,
  ): Promise<unknown>
  commitOwnerNativeInTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
    context: PostgresqlResourcePackageMutationRequestContext,
    input: Readonly<{
      mutation: CapabilityTemplatePackageMutation
      resourceId: string
      payload: Readonly<Record<string, unknown>>
      prepared: unknown
      ownership: Readonly<{
        authority: ResourceRequestContext
        ownerUserId: string
        visibility: 'private'
        builtin: false
      }>
    }>,
  ): Promise<void>
}

export interface PostgresqlResourcePackagePrestageInput {
  /** Must durably persist the artifact before resolving. */
  recordArtifact(artifact: PostgresqlResourcePackageMutationArtifact): Promise<void>
}

export interface PostgresqlResourcePackageCompensationInput {
  readonly artifacts: readonly PostgresqlResourcePackageMutationArtifact[]
  readonly databaseCommitted: boolean
}

export interface PostgresqlResourcePackageApplyReceipt {
  readonly journalId: string
  readonly applied: readonly ResourcePackageMutationReceipt[]
  readonly root?: Readonly<{
    resourceType: ResourcePackageMutationReceipt['resourceType']
    resourceId: string
    name: string
    action: 'create' | 'update' | 'reuse'
  }>
  readonly skippedSecrets?: readonly Readonly<{
    resourceType: PackageResourceKind
    resourceName: string
    field: string
  }>[]
}

export interface PostgresqlResourcePackageRollForwardInput {
  readonly artifacts: readonly PostgresqlResourcePackageMutationArtifact[]
  readonly receipt: PostgresqlResourcePackageApplyReceipt
}

export interface PostgresqlResourcePackageMutationSession {
  readonly request: PostgresqlResourcePackageMutationRequestContext
  readonly participants: PostgresqlResourcePackagePreparationParticipants
  bindTransaction(
    transaction: PostgresqlResourceCatalogTransaction,
  ): PostgresqlResourcePackageTransactionSession
  prestage(
    prepared: PreparedPackageMutation,
    input: PostgresqlResourcePackagePrestageInput,
  ): Promise<void>
  compensate(input: PostgresqlResourcePackageCompensationInput): Promise<void>
  rollForward(input: PostgresqlResourcePackageRollForwardInput): Promise<void>
  afterCommitted(receipt: PostgresqlResourcePackageApplyReceipt): Promise<void>
}

export interface PostgresqlResourcePackageMutationSessionFactory {
  create(
    input: PostgresqlResourcePackageMutationSessionCreateInput,
  ): PostgresqlResourcePackageMutationSession
}

export interface PostgresqlResourcePackageMutationSessionFactoryInput {
  readonly authorityResolver: ResourceCurrentAuthorityResolver
  readonly mcpLifecycle: PostgresqlMcpTransactionLifecycle
  readonly pluginArtifacts: PostgresqlResourcePackagePluginArtifactOwner
  readonly skillArtifacts: PostgresqlResourcePackageSkillArtifactOwner
  readonly capabilityTemplates: PostgresqlCapabilityTemplatePackageMutationOwner
  readonly afterCommitted?: (
    context: PostgresqlResourcePackageMutationRequestContext,
    receipt: PostgresqlResourcePackageApplyReceipt,
  ) => Promise<void>
  readonly id?: () => string
  readonly now?: () => number
}

function pendingIds(id: () => string): PostgresqlResourcePackageRequestIds {
  const byKey = new Map<string, PostgresqlResourcePackagePendingResourceId>()
  const keyOf = (input: { readonly type: PackageResourceKind; readonly localSlug: string }) =>
    `${input.type}\u0000${input.localSlug}`
  const ids: PostgresqlResourcePackageRequestIds = {
    mintCreate(input) {
      const key = keyOf(input)
      const existing = byKey.get(key)
      if (existing !== undefined) return existing.resourceId
      const resourceId = id()
      byKey.set(key, Object.freeze({ ...input, resourceId }))
      return resourceId
    },
    findCreate(input) {
      return byKey.get(keyOf(input))?.resourceId ?? null
    },
    listPending() {
      return Object.freeze([...byKey.values()])
    },
  }
  return Object.freeze(ids)
}

type PostgresqlResourcePackagePreparedState =
  | Readonly<{
      type: 'agent'
      mutation: AgentPackageMutation
      resourceId: string
    }>
  | Readonly<{
      type: 'skill'
      mutation: SkillPackageMutation
      resourceId: string
    }>
  | Readonly<{
      type: 'mcp'
      mutation: McpPackageMutation
      resourceId: string
    }>
  | Readonly<{
      type: 'plugin'
      mutation: PluginPackageMutation
      resourceId: string
    }>
  | Readonly<{
      type: 'workflow'
      mutation: WorkflowPackageMutation
      resourceId: string
    }>
  | Readonly<{
      type: 'workgroup'
      mutation: WorkgroupPackageMutation
      resourceId: string
    }>
  | Readonly<{
      type: 'capability_template'
      mutation: CapabilityTemplatePackageMutation
      resourceId: string
      ownerPrepared: unknown
    }>

type PostgresqlResourcePackageMutationIdentity =
  | Readonly<{
      kind: string
      slug: string
      payload: Readonly<{ name: string }>
    }>
  | Readonly<{
      kind: string
      target: string
      payload: Readonly<{ name: string }>
    }>

function pendingNameKey(type: PackageResourceKind, localSlug: string): string {
  return `${type}\u0000${localSlug}`
}

function mutationResourceId(input: {
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly pendingNames: Map<string, PostgresqlResourcePackagePendingName>
  readonly type: PackageResourceKind
  readonly mutation: PostgresqlResourcePackageMutationIdentity
}): string {
  if ('slug' in input.mutation) {
    const resourceId = input.context.ids.mintCreate({
      type: input.type,
      localSlug: input.mutation.slug,
    })
    input.pendingNames.set(
      pendingNameKey(input.type, input.mutation.slug),
      Object.freeze({
        type: input.type,
        localSlug: input.mutation.slug,
        resourceId,
        name: input.mutation.payload.name,
      }),
    )
    return resourceId
  }
  const decoded = decodeBundleIdentityRef(input.mutation.target)
  if (decoded?.k !== 'external') {
    throw new ValidationError(
      'bundle-target-invalid',
      `${input.mutation.kind} target must be an external ${input.type} reference`,
    )
  }
  return decoded.token
}

function preparedState(
  states: WeakMap<object, PostgresqlResourcePackagePreparedState>,
  prepared: PreparedPackageMutation,
): PostgresqlResourcePackagePreparedState {
  assertTrustedResourcePackageCapability(prepared)
  const state = states.get(prepared)
  if (state === undefined) throw new Error('resource-package-prepared-state-missing')
  return state
}

function packageMutationReceipt<K extends ResourcePackageMutationReceipt['resourceType']>(
  resourceType: K,
  state: Readonly<{
    mutation: Readonly<{ opId: string; kind: string; payload: Readonly<{ name: string }> }>
    resourceId: string
  }>,
): ResourcePackageMutationReceipt<K> {
  return Object.freeze({
    resourceType,
    operationId: state.mutation.opId,
    resourceId: state.resourceId,
    action: state.mutation.kind.endsWith('-create') ? 'create' : 'update',
    name: state.mutation.payload.name,
  })
}

function preparationParticipants(input: {
  readonly owner: PostgresqlCapabilityTemplatePackageMutationOwner
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly states: WeakMap<object, PostgresqlResourcePackagePreparedState>
  readonly pendingNames: Map<string, PostgresqlResourcePackagePendingName>
}): PostgresqlResourcePackagePreparationParticipants {
  const resourceId = (
    type: PackageResourceKind,
    mutation: PostgresqlResourcePackageMutationIdentity,
  ) =>
    mutationResourceId({ context: input.context, pendingNames: input.pendingNames, type, mutation })
  const participants: PostgresqlResourcePackagePreparationParticipants = {
    agents: Object.freeze({
      async prepareOpaque(mutation: AgentPackageMutation) {
        const prepared = createPreparedAgentPackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({ type: 'agent', mutation, resourceId: resourceId('agent', mutation) }),
        )
        return prepared
      },
    }),
    skills: Object.freeze({
      async prepareOpaque(mutation: SkillPackageMutation) {
        const prepared = createPreparedSkillPackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({ type: 'skill', mutation, resourceId: resourceId('skill', mutation) }),
        )
        return prepared
      },
    }),
    mcps: Object.freeze({
      async prepareOpaque(mutation: McpPackageMutation) {
        const prepared = createPreparedMcpPackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({ type: 'mcp', mutation, resourceId: resourceId('mcp', mutation) }),
        )
        return prepared
      },
    }),
    plugins: Object.freeze({
      async prepareOpaque(mutation: PluginPackageMutation) {
        const prepared = createPreparedPluginPackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({ type: 'plugin', mutation, resourceId: resourceId('plugin', mutation) }),
        )
        return prepared
      },
    }),
    workflows: Object.freeze({
      async prepareOpaque(mutation: WorkflowPackageMutation) {
        const prepared = createPreparedWorkflowPackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({
            type: 'workflow',
            mutation,
            resourceId: resourceId('workflow', mutation),
          }),
        )
        return prepared
      },
    }),
    workgroups: Object.freeze({
      async prepareOpaque(mutation: WorkgroupPackageMutation) {
        const prepared = createPreparedWorkgroupPackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({
            type: 'workgroup',
            mutation,
            resourceId: resourceId('workgroup', mutation),
          }),
        )
        return prepared
      },
    }),
    capabilityTemplates: Object.freeze({
      async prepareOpaque(mutation: CapabilityTemplatePackageMutation) {
        const id = resourceId('capability_template', mutation)
        const ownerPrepared = await input.owner.prepareOwnerNative(input.context, {
          mutation,
          resourceId: id,
        })
        const prepared = createPreparedCapabilityTemplatePackageMutation(mutation)
        input.states.set(
          prepared,
          Object.freeze({
            type: 'capability_template',
            mutation,
            resourceId: id,
            ownerPrepared,
          }),
        )
        return prepared
      },
    }),
  }
  return Object.freeze(participants)
}

function transactionParticipants(input: {
  readonly transaction: PostgresqlResourceCatalogTransaction
  readonly reader: PostgresqlResourcePackageTransactionReader
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly states: WeakMap<object, PostgresqlResourcePackagePreparedState>
  readonly pendingNames: ReadonlyMap<string, PostgresqlResourcePackagePendingName>
  readonly skillPublications: WeakMap<object, PostgresqlResourcePackageSkillPublication>
  readonly pluginPublications: WeakMap<object, PostgresqlResourcePackagePluginPublication>
  readonly lifecycle: PostgresqlMcpTransactionLifecycle
  readonly capabilityTemplates: PostgresqlCapabilityTemplatePackageMutationOwner
  readonly id: () => string
  readonly now: () => number
}): PostgresqlResourcePackageTransactionParticipants {
  const common = {
    transaction: input.transaction,
    reader: input.reader,
    context: input.context,
    pendingNames: input.pendingNames,
    id: input.id,
    now: input.now,
  }
  const participants: PostgresqlResourcePackageTransactionParticipants = {
    agents: Object.freeze({
      async commit(prepared: PreparedAgentPackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'agent') throw new Error('resource-package-agent-state-mismatch')
        return await commitPostgresqlAgentPackageMutation({
          ...common,
          mutation: state.mutation,
          resourceId: state.resourceId,
        })
      },
    }),
    skills: Object.freeze({
      async commit(prepared: PreparedSkillPackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'skill') throw new Error('resource-package-skill-state-mismatch')
        const publication = input.skillPublications.get(prepared)
        if (publication === undefined) throw new Error('resource-package-skill-stage-missing')
        return await commitPostgresqlSkillPackageMutation({
          ...common,
          mutation: state.mutation,
          resourceId: state.resourceId,
          publication,
        })
      },
    }),
    mcps: Object.freeze({
      async commit(prepared: PreparedMcpPackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'mcp') throw new Error('resource-package-mcp-state-mismatch')
        return await commitPostgresqlMcpPackageMutation({
          ...common,
          mutation: state.mutation,
          resourceId: state.resourceId,
          lifecycle: input.lifecycle,
        })
      },
    }),
    plugins: Object.freeze({
      async commit(prepared: PreparedPluginPackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'plugin') throw new Error('resource-package-plugin-state-mismatch')
        const publication = input.pluginPublications.get(prepared)
        if (publication === undefined) throw new Error('resource-package-plugin-install-missing')
        return await commitPostgresqlPluginPackageMutation({
          ...common,
          mutation: state.mutation,
          resourceId: state.resourceId,
          publication,
        })
      },
    }),
    workflows: Object.freeze({
      async commit(prepared: PreparedWorkflowPackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'workflow') {
          throw new Error('resource-package-workflow-state-mismatch')
        }
        return await commitPostgresqlWorkflowPackageMutation({
          ...common,
          mutation: state.mutation,
          resourceId: state.resourceId,
        })
      },
    }),
    workgroups: Object.freeze({
      async commit(prepared: PreparedWorkgroupPackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'workgroup') {
          throw new Error('resource-package-workgroup-state-mismatch')
        }
        return await commitPostgresqlWorkgroupPackageMutation({
          ...common,
          mutation: state.mutation,
          resourceId: state.resourceId,
        })
      },
    }),
    capabilityTemplates: Object.freeze({
      async commit(prepared: PreparedCapabilityTemplatePackageMutation) {
        const state = preparedState(input.states, prepared)
        if (state.type !== 'capability_template') {
          throw new Error('resource-package-capability-template-state-mismatch')
        }
        await assertPostgresqlCapabilityTemplatePackageOverwrite({
          reader: input.reader,
          context: input.context,
          mutation: state.mutation,
          resourceId: state.resourceId,
        })
        const payload = await resolvePostgresqlCapabilityTemplatePackagePayload({
          reader: input.reader,
          context: input.context,
          mutation: state.mutation,
        })
        await input.capabilityTemplates.commitOwnerNativeInTransaction(
          input.transaction,
          input.context,
          {
            mutation: state.mutation,
            resourceId: state.resourceId,
            payload,
            prepared: state.ownerPrepared,
            ownership: Object.freeze({
              authority: input.context.authority,
              ownerUserId: input.context.actor.user.id,
              visibility: 'private',
              builtin: false,
            }),
          },
        )
        return packageMutationReceipt('capability_template', state)
      },
    }),
  }
  return Object.freeze(participants)
}

async function prestagePreparedMutation(input: {
  readonly prepared: PreparedPackageMutation
  readonly journal: PostgresqlResourcePackagePrestageInput
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly states: WeakMap<object, PostgresqlResourcePackagePreparedState>
  readonly pluginPublications: WeakMap<object, PostgresqlResourcePackagePluginPublication>
  readonly skillPublications: WeakMap<object, PostgresqlResourcePackageSkillPublication>
  readonly pluginArtifacts: PostgresqlResourcePackagePluginArtifactOwner
  readonly skillArtifacts: PostgresqlResourcePackageSkillArtifactOwner
  readonly id: () => string
}): Promise<void> {
  const state = preparedState(input.states, input.prepared)
  if (state.type === 'plugin') {
    if (input.pluginPublications.has(input.prepared)) {
      throw new Error('resource-package-plugin-already-prestaged')
    }
    const generationId = input.id()
    const plan = input.pluginArtifacts.planInstall(input.context, {
      mutation: state.mutation,
      pluginId: state.resourceId,
      generationId,
    })
    if (
      plan.artifact.kind !== 'plugin-install' ||
      plan.artifact.operationId !== state.mutation.opId ||
      plan.artifact.pluginId !== state.resourceId ||
      plan.artifact.generationId !== generationId
    ) {
      throw new Error('resource-package-plugin-artifact-mismatch')
    }
    await input.journal.recordArtifact(plan.artifact)
    input.pluginPublications.set(input.prepared, await plan.install())
    return
  }
  if (state.type !== 'skill') return
  if (input.context.readSkillFile === undefined) {
    throw new Error('resource-package-skill-file-reader-missing')
  }
  if (input.skillPublications.has(input.prepared)) {
    throw new Error('resource-package-skill-already-prestaged')
  }
  if (state.mutation.kind === 'skill-create') {
    const plan = input.skillArtifacts.planCreate(input.context, {
      mutation: state.mutation,
      skillId: state.resourceId,
    })
    if (
      plan.artifact.kind !== 'skill-stage' ||
      plan.artifact.operationId !== state.mutation.opId ||
      plan.artifact.skillId !== state.resourceId
    ) {
      throw new Error('resource-package-skill-create-artifact-mismatch')
    }
    await input.journal.recordArtifact(plan.artifact)
    input.skillPublications.set(input.prepared, await plan.stage())
    return
  }
  const publishId = input.id()
  const version = state.mutation.expect.expectedContentVersion + 1
  const plan = input.skillArtifacts.planUpdate(input.context, {
    mutation: state.mutation,
    skillId: state.resourceId,
    publishId,
    version,
  })
  if (
    plan.artifact.kind !== 'skill-version-stage' ||
    plan.artifact.operationId !== state.mutation.opId ||
    plan.artifact.skillId !== state.resourceId ||
    plan.artifact.publishId !== publishId ||
    plan.artifact.version !== version
  ) {
    throw new Error('resource-package-skill-update-artifact-mismatch')
  }
  await input.journal.recordArtifact(plan.artifact)
  input.skillPublications.set(input.prepared, await plan.stage())
}

async function compensateArtifacts(input: {
  readonly ownerInput: PostgresqlResourcePackageMutationSessionFactoryInput
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly compensation: PostgresqlResourcePackageCompensationInput
}): Promise<void> {
  for (const artifact of [...input.compensation.artifacts].reverse()) {
    if (artifact.kind === 'plugin-install') {
      await input.ownerInput.pluginArtifacts.compensate(input.context, {
        artifact,
        databaseCommitted: input.compensation.databaseCommitted,
      })
      continue
    }
    await input.ownerInput.skillArtifacts.compensate(input.context, {
      artifact,
      databaseCommitted: input.compensation.databaseCommitted,
    })
  }
}

async function rollForwardArtifacts(input: {
  readonly ownerInput: PostgresqlResourcePackageMutationSessionFactoryInput
  readonly context: PostgresqlResourcePackageMutationRequestContext
  readonly rollForward: PostgresqlResourcePackageRollForwardInput
}): Promise<void> {
  for (const artifact of input.rollForward.artifacts) {
    if (artifact.kind === 'plugin-install') {
      await input.ownerInput.pluginArtifacts.rollForward(input.context, {
        artifact,
        receipt: input.rollForward.receipt,
      })
      continue
    }
    await input.ownerInput.skillArtifacts.rollForward(input.context, {
      artifact,
      receipt: input.rollForward.receipt,
    })
  }
}

export function createPostgresqlResourcePackageMutationSessionFactory(
  input: PostgresqlResourcePackageMutationSessionFactoryInput,
): PostgresqlResourcePackageMutationSessionFactory {
  const mintId = input.id ?? ulid
  const now = input.now ?? Date.now
  const factory: PostgresqlResourcePackageMutationSessionFactory = {
    create(request) {
      const actor = input.authorityResolver.resolve(request.authority)
      if (actor !== request.actor) throw new Error('foreign-resource-package-authority')
      const context: PostgresqlResourcePackageMutationRequestContext = Object.freeze({
        actor,
        authority: request.authority,
        humanMemberMappings: Object.freeze([...request.humanMemberMappings]),
        secretInputs: Object.freeze([...request.secretInputs]),
        ...(request.readSkillFile === undefined ? {} : { readSkillFile: request.readSkillFile }),
        ids: pendingIds(mintId),
      })
      const states = new WeakMap<object, PostgresqlResourcePackagePreparedState>()
      const pendingNames = new Map<string, PostgresqlResourcePackagePendingName>()
      const skillPublications = new WeakMap<object, PostgresqlResourcePackageSkillPublication>()
      const pluginPublications = new WeakMap<object, PostgresqlResourcePackagePluginPublication>()
      const session: PostgresqlResourcePackageMutationSession = {
        request: context,
        participants: preparationParticipants({
          owner: input.capabilityTemplates,
          context,
          states,
          pendingNames,
        }),
        bindTransaction(transaction) {
          const reader = bindPostgresqlResourcePackageTransactionReader(transaction, context.actor)
          return Object.freeze({
            reader,
            participants: transactionParticipants({
              transaction,
              reader,
              context,
              states,
              pendingNames,
              skillPublications,
              pluginPublications,
              lifecycle: input.mcpLifecycle,
              capabilityTemplates: input.capabilityTemplates,
              id: mintId,
              now,
            }),
          })
        },
        prestage: (prepared, journal) =>
          prestagePreparedMutation({
            prepared,
            journal,
            context,
            states,
            pluginPublications,
            skillPublications,
            pluginArtifacts: input.pluginArtifacts,
            skillArtifacts: input.skillArtifacts,
            id: mintId,
          }),
        compensate: (compensation) =>
          compensateArtifacts({ ownerInput: input, context, compensation }),
        rollForward: (rollForward) =>
          rollForwardArtifacts({ ownerInput: input, context, rollForward }),
        async afterCommitted(receipt) {
          await input.pluginArtifacts.afterCommitted(context, receipt)
          await input.skillArtifacts.afterCommitted(context, receipt)
          await input.afterCommitted?.(context, receipt)
        },
      }
      return Object.freeze(session)
    },
  }
  return Object.freeze(factory)
}

export interface PostgresqlResourcePackageAtomicApplyInput<TPackage> {
  readonly authority: ResourceRequestContext
  readonly actor: Actor
  readonly package: TPackage
  readonly previewToken: string
  readonly decisions: readonly ResourcePackageImportDecision[]
  readonly humanMemberMappings: readonly ResourcePackageHumanMemberMapping[]
  readonly secretInputs: readonly ResourcePackageSecretInput[]
  readonly mutationSessionFactory: PostgresqlResourcePackageMutationSessionFactory
}

/**
 * Lane B creates exactly one mutation session per apply, supplies its package
 * file reader, then binds that session once to the reserved PostgreSQL
 * transaction. No Resource Catalog method opens a nested transaction.
 */
export interface PostgresqlResourcePackageAtomicApplyOrchestrator<TPackage> {
  apply(
    input: PostgresqlResourcePackageAtomicApplyInput<TPackage>,
  ): Promise<PostgresqlResourcePackageApplyReceipt>
}
