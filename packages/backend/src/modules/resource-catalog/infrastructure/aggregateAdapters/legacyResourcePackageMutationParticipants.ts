// RFC-345 T6 — compatibility participants for the current BundleApply lifecycle.
//
// BundleApply still owns claim/journal/pre-stage ordering/big-tx/roll-forward/recovery until W6.
// This adapter owns the seven aggregate-specific prepare/commit arms so the lifecycle engine no
// longer reaches into seven legacy writers directly. The public participant contract stays free of
// Actor/SQLite/filesystem values. Legacy service functions are supplied through the module-owned
// dependency port so infrastructure never imports the compatibility service layer in reverse.

import { eq } from 'drizzle-orm'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import { stringify as stringifyYaml } from 'yaml'
import {
  CreateAgentSchema,
  CreateMcpSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type BundleOp,
  type BundleOpKind,
  type BundleResourceType,
  type CreateMcp,
  type CreateWorkgroup,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { plugins, skillOperations } from '@/db/schema'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { Logger } from '@/util/log'
import { monotonicNow } from '@/util/time'
import {
  assertTrustedResourcePackageCapability,
  createAgentPackageMutationParticipantInTx,
  createCapabilityTemplatePackageMutationParticipantInTx,
  createMcpPackageMutationParticipantInTx,
  createPluginPackageMutationParticipantInTx,
  createPreparedAgentPackageMutation,
  createPreparedCapabilityTemplatePackageMutation,
  createPreparedMcpPackageMutation,
  createPreparedPluginPackageMutation,
  createPreparedSkillPackageMutation,
  createPreparedWorkflowPackageMutation,
  createPreparedWorkgroupPackageMutation,
  createResourcePackageApplyTx,
  createResourcePackageAuditInTx,
  createResourcePackageEventsInTx,
  createSkillPackageMutationParticipantInTx,
  createWorkflowPackageMutationParticipantInTx,
  createWorkgroupPackageMutationParticipantInTx,
} from '../../application/participants/resourcePackageCapabilities'
import type {
  ResourcePackageApplyScenarioProvider,
  ResourcePackageApplyTx,
} from '../../public/participants'
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
  ResourcePackageApplyScenarioPlan,
  ResourcePackageMutationReceipt,
  SkillPackageMutation,
  WorkflowPackageMutation,
  WorkgroupPackageMutation,
} from '../../public/types'

export interface ResourcePackageMutationOperation {
  readonly opId: string
  readonly kind: BundleOpKind
  readonly resourceType: BundleResourceType
  readonly action: 'create' | 'update'
  readonly resourceId: string
  readonly payload: Record<string, unknown>
  readonly expect?: Record<string, unknown>
}

type AgentOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'agent'
  readonly kind: 'agent-create' | 'agent-update'
}
type SkillOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'skill'
  readonly kind: 'skill-create' | 'skill-update'
}
type McpOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'mcp'
  readonly kind: 'mcp-create' | 'mcp-update'
}
type PluginOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'plugin'
  readonly kind: 'plugin-create' | 'plugin-update'
}
type WorkflowOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'workflow'
  readonly kind: 'workflow-create' | 'workflow-update'
}
type WorkgroupOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'workgroup'
  readonly kind: 'workgroup-create' | 'workgroup-update'
}
type CapabilityTemplateOperation = ResourcePackageMutationOperation & {
  readonly resourceType: 'capability_template'
  readonly kind:
    | 'capability-framework-create'
    | 'capability-framework-update'
    | 'capability-binding-create'
    | 'capability-binding-update'
    | 'capability-template-create'
    | 'capability-template-update'
}

export type PreparedResourcePackageMutation =
  | {
      op: AgentOperation
      resourceType: 'agent'
      kind: 'agent-create'
      prepared: unknown
    }
  | {
      op: AgentOperation
      resourceType: 'agent'
      kind: 'agent-update'
      prepared: unknown
    }
  | { op: McpOperation; resourceType: 'mcp'; kind: 'mcp-create'; prepared: unknown }
  | { op: McpOperation; resourceType: 'mcp'; kind: 'mcp-update'; prepared: unknown }
  | {
      op: PluginOperation
      resourceType: 'plugin'
      kind: 'plugin-create'
      spec: string
      parsed: Record<string, unknown>
    }
  | {
      op: PluginOperation
      resourceType: 'plugin'
      kind: 'plugin-update'
      spec: string
      captured: Record<string, unknown>
    }
  | { op: SkillOperation; resourceType: 'skill'; kind: 'skill-create' }
  | { op: SkillOperation; resourceType: 'skill'; kind: 'skill-update' }
  | {
      op: WorkflowOperation
      resourceType: 'workflow'
      kind: 'workflow-create'
      definition: WorkflowDefinition
    }
  | {
      op: WorkflowOperation
      resourceType: 'workflow'
      kind: 'workflow-update'
      prepared: unknown
    }
  | {
      op: WorkgroupOperation
      resourceType: 'workgroup'
      kind: 'workgroup-create'
      prepared: unknown
    }
  | {
      op: WorkgroupOperation
      resourceType: 'workgroup'
      kind: 'workgroup-update'
      prepared: unknown
    }
  | {
      op: CapabilityTemplateOperation
      resourceType: 'capability_template'
      kind: 'capability-template'
      prepared: unknown
    }

export type ResourcePackageMutationArtifact =
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  | { kind: 'skill-version-stage'; staged: LegacyStagedSkillVersion }
  | { kind: 'plugin-install'; pluginId: string; generationId: string; generationDir: string }

export interface ResourcePackageMutationPreparationContext {
  readonly pendingIds: Set<string>
  readonly pendingAgentNames: Map<string, string>
  readonly key: string
}

export interface ResourcePackageMutationPrestageContext {
  readonly readSkillFile: (ref: string) => Uint8Array
  readonly recordArtifact: (artifact: ResourcePackageMutationArtifact) => void
}

export interface ResourcePackageMutationCommitContext {
  readonly bundleCreatedNames: {
    readonly workflow: Set<string>
    readonly workgroup: Set<string>
  }
}

export interface LegacyResourcePackageMutationParticipants {
  readonly agents: {
    prepare(
      operation: AgentOperation,
      context: ResourcePackageMutationPreparationContext,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'agent' }>>
  }
  readonly skills: {
    prepare(
      operation: SkillOperation,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'skill' }>>
  }
  readonly mcps: {
    prepare(
      operation: McpOperation,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'mcp' }>>
  }
  readonly plugins: {
    prepare(
      operation: PluginOperation,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'plugin' }>>
  }
  readonly workflows: {
    prepare(
      operation: WorkflowOperation,
      context: ResourcePackageMutationPreparationContext,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'workflow' }>>
  }
  readonly workgroups: {
    prepare(
      operation: WorkgroupOperation,
      context: ResourcePackageMutationPreparationContext,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'workgroup' }>>
  }
  readonly capabilityTemplates: {
    prepare(
      operation: CapabilityTemplateOperation,
    ): Promise<Extract<PreparedResourcePackageMutation, { resourceType: 'capability_template' }>>
  }
}

export interface LegacyResourcePackageMutationAdapter {
  readonly participants: LegacyResourcePackageMutationParticipants
  createScenarioProvider(input: {
    readonly scenario: ResourcePackageApplyScenarioPlan
    readonly operations: readonly BundleOp[]
    readonly lowered: readonly ResourcePackageMutationOperation[]
    context: ResourcePackageMutationPreparationContext
  }): ResourcePackageApplyScenarioProvider
  prestage(
    prepared: PreparedPackageMutation,
    context: ResourcePackageMutationPrestageContext,
  ): Promise<void>
  assertUpdateTargetsOwnedInTx(
    tx: DbTxSync,
    operations: readonly ResourcePackageMutationOperation[],
  ): void
  bindApplyTx(
    tx: DbTxSync,
    input: ResourcePackageMutationCommitContext & {
      readonly currentAuthority: () => ResourcePackageApplyTx['currentAuthority']
    },
  ): ResourcePackageApplyTx
  rollForwardCommitted(log: Logger): void
  broadcastCommitted(): void
}

export interface LegacyResourcePackageMutationAdapterOptions {
  readonly db: DbClient
  readonly appHome: string
  readonly actor: Actor
  readonly pluginInstallOpts?: { pluginsDir?: string; npmBin?: string; timeoutMs?: number }
  readonly afterPluginInstall?: () => void
  readonly afterSkillStage?: () => void
}

export interface LegacyStagedSkillVersion {
  readonly skillId: string
  readonly skillName: string
  readonly opId: string | null
  readonly publishId: string
  readonly newVersion: number
  readonly newHash: string
  readonly filesDir: string
  readonly versionDir: string
  readonly stagingDir: string
  readonly noop: unknown
}

interface LegacyPluginInstallResult {
  readonly generationDir: string | null
  readonly sourceKind: 'npm' | 'git' | 'file'
  readonly cachedPath: string
  readonly resolvedVersion: string | null
}

interface LegacyInitialResourceAcl {
  readonly ownerUserId: string | null
  readonly visibility: 'private'
  readonly aclRevision: 0
}

/**
 * Legacy implementation port supplied by the service-side compatibility
 * composer. Keeping this interface module-owned preserves the seven exact
 * participant arms while preventing infrastructure from importing legacy
 * services in reverse.
 */
export interface LegacyResourcePackageMutationDependencies {
  readonly prepareTemplateFromBundle: (
    db: DbClient,
    payload: unknown,
    actor: Actor,
    existingId: string | null,
  ) => Promise<unknown>
  readonly commitTemplateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly prepareAgentCreate: (
    db: DbClient,
    input: ReturnType<typeof CreateAgentSchema.parse>,
    options: {
      readonly ownerUserId: string
      readonly actor: Actor
      readonly id: string
      readonly pendingBundleIds: ReadonlySet<string>
    },
  ) => Promise<unknown>
  readonly getAgentById: (db: DbClient, id: string) => Promise<unknown | null>
  readonly prepareAgentUpdate: (
    db: DbClient,
    id: string,
    patch: ReturnType<typeof UpdateAgentSchema.parse>,
    actor: Actor,
    expect: { readonly expectedUpdatedAt: number; readonly expectedAclRevision: number },
    options: { readonly pendingBundleIds: ReadonlySet<string> },
  ) => Promise<unknown>
  readonly commitAgentCreateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly commitAgentUpdateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly prepareMcpCreate: (
    db: DbClient,
    input: CreateMcp,
    options: { readonly ownerUserId: string; readonly actor: Actor },
    resourceId: string,
  ) => Promise<unknown>
  readonly getMcpById: (
    db: DbClient,
    id: string,
  ) => Promise<{ readonly type: 'local' | 'remote'; readonly updatedAt: number } | null>
  readonly commitMcpCreateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly commitMcpUpdateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly commitPluginCreateInTx: (
    tx: DbTxSync,
    input: {
      readonly id: string
      readonly parsed: unknown
      readonly initialAcl: LegacyInitialResourceAcl
      readonly install: LegacyPluginInstallResult
      readonly now: number
    },
  ) => void
  readonly commitPluginPublishInTx: (
    tx: DbTxSync,
    captured: unknown,
    input: Readonly<Record<string, unknown>>,
  ) => void
  readonly plannedGenerationDir: (
    pluginId: string,
    spec: string,
    generationId: string,
    pluginsDir?: string,
  ) => string | null
  readonly installPlugin: (
    pluginId: string,
    spec: string,
    options: {
      readonly pluginsDir?: string
      readonly npmBin?: string
      readonly timeoutMs?: number
      readonly generationId: string
    },
  ) => Promise<LegacyPluginInstallResult>
  readonly getAclResourceOwnerInTx: (
    tx: DbTxSync,
    type: BundleResourceType,
    resourceId: string,
  ) => string | null | undefined
  readonly initialPrivateResourceAcl: (ownerUserId: string) => LegacyInitialResourceAcl
  readonly assertRefsUsableInTx: (
    tx: DbTxSync,
    actor: Actor,
    requests: readonly Readonly<Record<string, unknown>>[],
  ) => void
  readonly extractWorkflowWorkflowRefs: (definition: WorkflowDefinition) => string[]
  readonly extractWorkflowWorkgroupRefs: (definition: WorkflowDefinition) => string[]
  readonly stageManagedSkill: (
    db: DbClient,
    options: { readonly appHome: string },
    input: Readonly<Record<string, unknown>>,
    produce: (filesDir: string) => void,
  ) => Promise<{ readonly skillId: string; readonly opId: string; readonly skillDir: string }>
  readonly compensateManagedSkillStage: (
    db: DbClient,
    stage: { readonly skillId: string; readonly opId: string; readonly skillDir: string },
  ) => void
  readonly commitSkillReadyInTx: (
    tx: DbTxSync,
    input: { readonly skillId: string; readonly opId: string },
  ) => void
  readonly stageSkillVersion: (
    db: DbClient,
    options: { readonly appHome: string },
    skillId: string,
    produce: (stagingDir: string) => void,
    commit: Readonly<Record<string, unknown>>,
  ) => LegacyStagedSkillVersion
  readonly abortStagedSkillVersion: (db: DbClient, staged: LegacyStagedSkillVersion) => void
  readonly commitSkillVersionInTx: (
    tx: DbTxSync,
    staged: LegacyStagedSkillVersion,
    commit: Readonly<Record<string, unknown>>,
  ) => void
  readonly publishStagedSkillVersion: (
    db: DbClient,
    options: { readonly appHome: string },
    staged: LegacyStagedSkillVersion,
  ) => void
  readonly unmarkSkillBootVerified: (skillId: string) => void
  readonly finishOperation: (tx: DbTxSync, opId: string) => void
  readonly prepareWorkflowSave: (
    db: DbClient,
    id: string,
    input: Readonly<Record<string, unknown>>,
    principal: { readonly kind: 'actor'; readonly actor: Actor },
  ) => Promise<unknown>
  readonly insertWorkflowInTx: (tx: DbTxSync, input: Readonly<Record<string, unknown>>) => unknown
  readonly commitWorkflowSaveInTx: (
    tx: DbTxSync,
    prepared: unknown,
  ) => { readonly committed: boolean; readonly receipt: { readonly outcome: string } }
  readonly rowToWorkflowDetail: (row: unknown) => unknown
  readonly broadcastWorkflowCreated: (workflow: unknown) => void
  readonly prepareWorkgroupCreate: (
    db: DbClient,
    input: CreateWorkgroup,
    options: Readonly<Record<string, unknown>>,
    resourceId: string,
  ) => Promise<unknown>
  readonly prepareWorkgroupSave: (
    db: DbClient,
    id: string,
    input: Readonly<Record<string, unknown>>,
    principal: { readonly kind: 'actor'; readonly actor: Actor },
  ) => Promise<unknown>
  readonly commitWorkgroupCreateInTx: (tx: DbTxSync, prepared: unknown) => unknown
  readonly commitWorkgroupSaveInTx: (
    tx: DbTxSync,
    prepared: unknown,
  ) => { readonly committed: boolean; readonly receipt: { readonly outcome: string } }
  readonly broadcastWorkgroupCreated: (workgroup: unknown) => void
}

export function createLegacyResourcePackageMutationAdapter(
  options: LegacyResourcePackageMutationAdapterOptions,
  dependencies: LegacyResourcePackageMutationDependencies,
): LegacyResourcePackageMutationAdapter {
  const { db, appHome, actor } = options
  const pluginInstalls = new Map<string, LegacyPluginInstallResult>()
  const skillStages = new Map<string, { skillId: string; opId: string; skillDir: string }>()
  const skillVersionStages = new Map<string, LegacyStagedSkillVersion>()
  const createdWorkflowRows: unknown[] = []
  const createdWorkgroups: unknown[] = []
  const preparedInternals = new WeakMap<object, PreparedResourcePackageMutation>()

  const rememberPrepared = <T extends PreparedPackageMutation>(
    capability: T,
    prepared: PreparedResourcePackageMutation,
  ): T => {
    preparedInternals.set(capability, prepared)
    return capability
  }

  const internalPrepared = (
    capability: PreparedPackageMutation,
  ): PreparedResourcePackageMutation => {
    assertTrustedResourcePackageCapability(capability)
    const prepared = preparedInternals.get(capability)
    if (prepared === undefined) throw new Error('resource-package-prepared-capability-expired')
    return prepared
  }

  const mutationReceipt = (
    prepared: PreparedResourcePackageMutation,
  ): ResourcePackageMutationReceipt => ({
    resourceType: prepared.op.resourceType,
    operationId: prepared.op.opId,
    resourceId: prepared.op.resourceId,
    action: prepared.op.action,
    name: String(prepared.op.payload.name ?? ''),
  })

  const participants: LegacyResourcePackageMutationParticipants = {
    agents: {
      async prepare(operation, context) {
        if (operation.kind === 'agent-create') {
          const parsed = CreateAgentSchema.parse(operation.payload)
          const prepared = await dependencies.prepareAgentCreate(db, parsed, {
            ownerUserId: actor.user.id,
            actor,
            id: operation.resourceId,
            pendingBundleIds: context.pendingIds,
          })
          return { op: operation, resourceType: 'agent', kind: 'agent-create', prepared }
        }
        const existing = await dependencies.getAgentById(db, operation.resourceId)
        if (existing === null) throw new NotFoundError('agent-not-found', 'agent not found')
        const { name: _name, ...patchBody } = operation.payload
        const patch = UpdateAgentSchema.parse(patchBody)
        const expect = operation.expect as {
          expectedUpdatedAt: number
          expectedAclRevision: number
        }
        const prepared = await dependencies.prepareAgentUpdate(
          db,
          operation.resourceId,
          patch,
          actor,
          expect,
          { pendingBundleIds: context.pendingIds },
        )
        return { op: operation, resourceType: 'agent', kind: 'agent-update', prepared }
      },
    },
    skills: {
      async prepare(operation) {
        return { op: operation, resourceType: 'skill', kind: operation.kind }
      },
    },
    mcps: {
      async prepare(operation) {
        if (operation.kind === 'mcp-create') {
          const parsed: CreateMcp = CreateMcpSchema.parse(operation.payload)
          const prepared = await dependencies.prepareMcpCreate(
            db,
            parsed,
            {
              ownerUserId: actor.user.id,
              actor,
            },
            operation.resourceId,
          )
          return {
            op: operation,
            resourceType: 'mcp',
            kind: 'mcp-create',
            prepared,
          }
        }
        const existing = await dependencies.getMcpById(db, operation.resourceId)
        if (existing === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
        const payload = operation.payload as unknown as CreateMcp
        if (payload.type !== existing.type) {
          throw new ValidationError('mcp-type-immutable', 'mcp type cannot change')
        }
        const expect = operation.expect as { expectedConfigHash: string }
        return {
          op: operation,
          resourceType: 'mcp',
          kind: 'mcp-update',
          prepared: {
            id: operation.resourceId,
            set: {
              updatedAt: monotonicNow(existing.updatedAt),
              description: payload.description,
              enabled: payload.enabled,
              config: JSON.stringify(payload.config),
            },
            expectedConfigHash: expect.expectedConfigHash,
            expectedOwnerUserId: actor.user.id,
          },
        }
      },
    },
    plugins: {
      async prepare(operation) {
        const payload = operation.payload as { spec: string } & Record<string, unknown>
        return operation.kind === 'plugin-create'
          ? {
              op: operation,
              resourceType: 'plugin',
              kind: 'plugin-create',
              spec: payload.spec,
              parsed: payload,
            }
          : {
              op: operation,
              resourceType: 'plugin',
              kind: 'plugin-update',
              spec: payload.spec,
              captured: payload,
            }
      },
    },
    workflows: {
      async prepare(operation, context) {
        if (operation.kind === 'workflow-create') {
          const definition = migrateWorkflowDefinitionToLatest(
            WorkflowDefinitionSchema.parse(
              (operation.payload as { definition: unknown }).definition,
            ),
          )
          return {
            op: operation,
            resourceType: 'workflow',
            kind: 'workflow-create',
            definition,
          }
        }
        const expect = operation.expect as { expectedVersion: number }
        const payload = operation.payload as {
          name: string
          description: string
          definition: unknown
        }
        const prepared = await dependencies.prepareWorkflowSave(
          db,
          operation.resourceId,
          {
            expectedVersion: expect.expectedVersion,
            clientMutationId: context.key,
            snapshot: {
              name: payload.name,
              description: payload.description,
              definition: migrateWorkflowDefinitionToLatest(
                WorkflowDefinitionSchema.parse(payload.definition),
              ),
            },
          },
          { kind: 'actor', actor },
        )
        return { op: operation, resourceType: 'workflow', kind: 'workflow-update', prepared }
      },
    },
    workgroups: {
      async prepare(operation, context) {
        if (operation.kind === 'workgroup-create') {
          const parsed: CreateWorkgroup = CreateWorkgroupSchema.parse(operation.payload)
          const prepared = await dependencies.prepareWorkgroupCreate(
            db,
            parsed,
            {
              ownerUserId: actor.user.id,
              actor,
              pendingAgentNames: context.pendingAgentNames,
            },
            operation.resourceId,
          )
          return {
            op: operation,
            resourceType: 'workgroup',
            kind: 'workgroup-create',
            prepared,
          }
        }
        const expect = operation.expect as { expectedVersion: number }
        const prepared = await dependencies.prepareWorkgroupSave(
          db,
          operation.resourceId,
          {
            expectedVersion: expect.expectedVersion,
            clientMutationId: context.key,
            snapshot: operation.payload,
          } as never,
          { kind: 'actor', actor },
        )
        return { op: operation, resourceType: 'workgroup', kind: 'workgroup-update', prepared }
      },
    },
    capabilityTemplates: {
      async prepare(operation) {
        const prepared = await dependencies.prepareTemplateFromBundle(
          db,
          { ...operation.payload, id: operation.resourceId } as never,
          actor,
          operation.kind.endsWith('-update') ? operation.resourceId : null,
        )
        return {
          op: operation,
          resourceType: 'capability_template',
          kind: 'capability-template',
          prepared,
        }
      },
    },
  }

  return {
    participants,
    createScenarioProvider({ scenario, operations, lowered, context }) {
      const loweredByMutation = new Map(
        operations.map((mutation, index) => [mutation, lowered[index]] as const),
      )
      const loweredAs = <T extends ResourcePackageMutationOperation>(
        mutation: BundleOp,
        resourceType: T['resourceType'],
      ): T => {
        // A bundle's opId is an idempotency/audit label, not the identity of
        // the in-memory planned mutation. Some compatibility callers still
        // supply repeated labels; indexing by opId aliases their pre-minted
        // resource ids and can make a dependency commit before its target.
        const operation = loweredByMutation.get(mutation)
        if (operation === undefined || operation.resourceType !== resourceType) {
          throw new Error(`resource-package-lowered-operation-missing:${mutation.opId}`)
        }
        return operation as T
      }
      if (operations.length !== lowered.length) {
        throw new Error('resource-package-lowered-operation-count-mismatch')
      }
      return Object.freeze({
        scenario,
        participants: Object.freeze({
          agents: Object.freeze({
            async prepare(mutation: AgentPackageMutation): Promise<PreparedAgentPackageMutation> {
              const prepared = await participants.agents.prepare(
                loweredAs<AgentOperation>(mutation, 'agent'),
                context,
              )
              return rememberPrepared(createPreparedAgentPackageMutation(mutation), prepared)
            },
          }),
          skills: Object.freeze({
            async prepare(mutation: SkillPackageMutation): Promise<PreparedSkillPackageMutation> {
              const prepared = await participants.skills.prepare(
                loweredAs<SkillOperation>(mutation, 'skill'),
              )
              return rememberPrepared(createPreparedSkillPackageMutation(mutation), prepared)
            },
          }),
          mcps: Object.freeze({
            async prepare(mutation: McpPackageMutation): Promise<PreparedMcpPackageMutation> {
              const prepared = await participants.mcps.prepare(
                loweredAs<McpOperation>(mutation, 'mcp'),
              )
              return rememberPrepared(createPreparedMcpPackageMutation(mutation), prepared)
            },
          }),
          plugins: Object.freeze({
            async prepare(mutation: PluginPackageMutation): Promise<PreparedPluginPackageMutation> {
              const prepared = await participants.plugins.prepare(
                loweredAs<PluginOperation>(mutation, 'plugin'),
              )
              return rememberPrepared(createPreparedPluginPackageMutation(mutation), prepared)
            },
          }),
          workflows: Object.freeze({
            async prepare(
              mutation: WorkflowPackageMutation,
            ): Promise<PreparedWorkflowPackageMutation> {
              const prepared = await participants.workflows.prepare(
                loweredAs<WorkflowOperation>(mutation, 'workflow'),
                context,
              )
              return rememberPrepared(createPreparedWorkflowPackageMutation(mutation), prepared)
            },
          }),
          workgroups: Object.freeze({
            async prepare(
              mutation: WorkgroupPackageMutation,
            ): Promise<PreparedWorkgroupPackageMutation> {
              const prepared = await participants.workgroups.prepare(
                loweredAs<WorkgroupOperation>(mutation, 'workgroup'),
                context,
              )
              return rememberPrepared(createPreparedWorkgroupPackageMutation(mutation), prepared)
            },
          }),
          capabilityTemplates: Object.freeze({
            async prepare(
              mutation: CapabilityTemplatePackageMutation,
            ): Promise<PreparedCapabilityTemplatePackageMutation> {
              const prepared = await participants.capabilityTemplates.prepare(
                loweredAs<CapabilityTemplateOperation>(mutation, 'capability_template'),
              )
              return rememberPrepared(
                createPreparedCapabilityTemplatePackageMutation(mutation),
                prepared,
              )
            },
          }),
        }),
      })
    },
    async prestage(prepared, context) {
      const internal = internalPrepared(prepared)
      if (internal.kind === 'plugin-create' || internal.kind === 'plugin-update') {
        const generationId = ulid()
        const generationDir = dependencies.plannedGenerationDir(
          internal.op.resourceId,
          internal.spec,
          generationId,
          options.pluginInstallOpts?.pluginsDir,
        )
        if (generationDir !== null) {
          context.recordArtifact({
            kind: 'plugin-install',
            pluginId: internal.op.resourceId,
            generationId,
            generationDir,
          })
        }
        const install = await dependencies.installPlugin(internal.op.resourceId, internal.spec, {
          ...options.pluginInstallOpts,
          generationId,
        })
        pluginInstalls.set(internal.op.opId, install)
        options.afterPluginInstall?.()
        return
      }
      if (internal.kind === 'skill-create') {
        const stage = await dependencies.stageManagedSkill(
          db,
          { appHome },
          {
            name: skillPayload(internal.op).name,
            description: skillPayload(internal.op).description,
            ownerUserId: actor.user.id,
            actor,
            id: internal.op.resourceId,
          },
          (filesDir) => writeSkillTree(filesDir, internal.op, context.readSkillFile),
        )
        skillStages.set(internal.op.opId, stage)
        context.recordArtifact({ kind: 'skill-stage', ...stage })
        options.afterSkillStage?.()
        return
      }
      if (internal.kind === 'skill-update') {
        const staged = dependencies.stageSkillVersion(
          db,
          { appHome },
          internal.op.resourceId,
          (stagingDir) => writeSkillTree(stagingDir, internal.op, context.readSkillFile),
          {
            source: 'import',
            authorUserId: actor.user.id,
            ...skillExpectOf(internal.op),
            expectedOwnerUserId: actor.user.id,
            setDescription: skillPayload(internal.op).description,
          },
        )
        skillVersionStages.set(internal.op.opId, staged)
        context.recordArtifact({ kind: 'skill-version-stage', staged })
        options.afterSkillStage?.()
      }
    },
    assertUpdateTargetsOwnedInTx(tx, operations) {
      for (const operation of operations) {
        if (operation.action !== 'update') continue
        const ownerUserId = dependencies.getAclResourceOwnerInTx(
          tx,
          operation.resourceType,
          operation.resourceId,
        )
        if (ownerUserId === undefined) {
          throw new NotFoundError(
            `${operation.resourceType}-not-found`,
            `update target '${operation.resourceId}' not found`,
          )
        }
        if (ownerUserId !== actor.user.id) {
          throw new ValidationError(
            'bundle-overwrite-not-owned',
            `cannot overwrite ${operation.resourceType} '${operation.resourceId}': it belongs to another user`,
          )
        }
      }
    },
    bindApplyTx(tx, input) {
      const applyPrepared = (prepared: PreparedResourcePackageMutation): void => {
        switch (prepared.kind) {
          case 'agent-create':
            dependencies.commitAgentCreateInTx(tx, prepared.prepared)
            return
          case 'agent-update':
            dependencies.commitAgentUpdateInTx(tx, prepared.prepared)
            return
          case 'mcp-create':
            dependencies.commitMcpCreateInTx(tx, prepared.prepared)
            return
          case 'mcp-update':
            dependencies.commitMcpUpdateInTx(tx, prepared.prepared)
            return
          case 'plugin-create': {
            const install = pluginInstalls.get(prepared.op.opId)
            if (install === undefined) throw new Error('plugin install result missing')
            dependencies.commitPluginCreateInTx(tx, {
              id: prepared.op.resourceId,
              parsed: prepared.parsed as never,
              initialAcl: dependencies.initialPrivateResourceAcl(actor.user.id),
              install,
              now: Date.now(),
            })
            return
          }
          case 'plugin-update': {
            const install = pluginInstalls.get(prepared.op.opId)
            if (install === undefined) throw new Error('plugin install result missing')
            const captured = selectPluginRowInTx(tx, prepared.op.resourceId)
            const payload = prepared.captured as {
              spec: string
              options?: Record<string, unknown>
              description?: string
              enabled?: boolean
            }
            dependencies.commitPluginPublishInTx(tx, captured, {
              spec: payload.spec,
              optionsJson: JSON.stringify(payload.options ?? {}),
              description: payload.description ?? captured.description,
              enabled: payload.enabled ?? captured.enabled,
              sourceKind: install.sourceKind,
              cachedPath: install.cachedPath,
              resolvedVersion: install.resolvedVersion,
              installedAt: Date.now(),
              updatedAt: monotonicNow(captured.updatedAt),
            })
            return
          }
          case 'skill-create': {
            const stage = skillStages.get(prepared.op.opId)
            if (stage === undefined) throw new Error('skill stage missing')
            dependencies.commitSkillReadyInTx(tx, { skillId: stage.skillId, opId: stage.opId })
            return
          }
          case 'skill-update': {
            const staged = skillVersionStages.get(prepared.op.opId)
            if (staged === undefined) throw new Error('skill version stage missing')
            dependencies.commitSkillVersionInTx(tx, staged, {
              source: 'import',
              authorUserId: actor.user.id,
              setDescription: skillPayload(prepared.op).description,
            })
            return
          }
          case 'workflow-create': {
            dependencies.assertRefsUsableInTx(tx, actor, [
              {
                type: 'agent',
                domain: 'id',
                names: (prepared.definition.nodes ?? [])
                  .filter(
                    (node) => node.kind === 'agent-single' && typeof node.agentId === 'string',
                  )
                  .map((node) => node.agentId as string),
              },
              {
                type: 'workflow',
                names: dependencies
                  .extractWorkflowWorkflowRefs(prepared.definition)
                  .filter((name) => !input.bundleCreatedNames.workflow.has(name)),
                domain: 'name',
              },
              {
                type: 'workgroup',
                names: dependencies
                  .extractWorkflowWorkgroupRefs(prepared.definition)
                  .filter((name) => !input.bundleCreatedNames.workgroup.has(name)),
                domain: 'name',
              },
            ])
            const payload = prepared.op.payload as { name: string; description: string }
            createdWorkflowRows.push(
              dependencies.insertWorkflowInTx(tx, {
                scriptPrincipal: { kind: 'actor', actor },
                id: prepared.op.resourceId,
                name: payload.name,
                description: payload.description,
                definition: prepared.definition,
                ownerUserId: actor.user.id,
                builtin: false,
                now: Date.now(),
              }),
            )
            return
          }
          case 'workflow-update': {
            const result = dependencies.commitWorkflowSaveInTx(tx, prepared.prepared)
            if (!result.committed && result.receipt.outcome !== 'already-current') {
              throw new ConflictError('bundle-baseline-stale', 'workflow save did not commit')
            }
            return
          }
          case 'workgroup-create':
            createdWorkgroups.push(dependencies.commitWorkgroupCreateInTx(tx, prepared.prepared))
            return
          case 'workgroup-update': {
            const result = dependencies.commitWorkgroupSaveInTx(tx, prepared.prepared)
            if (!result.committed && result.receipt.outcome !== 'already-current') {
              throw new ConflictError('bundle-baseline-stale', 'workgroup save did not commit')
            }
            return
          }
          case 'capability-template':
            dependencies.commitTemplateInTx(tx, prepared.prepared)
        }
      }
      const commitCapability = <K extends ResourcePackageMutationReceipt['resourceType']>(
        capability: PreparedPackageMutation,
        resourceType: K,
      ): ResourcePackageMutationReceipt<K> => {
        const prepared = internalPrepared(capability)
        if (prepared.op.resourceType !== resourceType) {
          throw new Error('resource-package-participant-kind-mismatch')
        }
        applyPrepared(prepared)
        const receipt = mutationReceipt(prepared)
        return {
          resourceType,
          operationId: receipt.operationId,
          resourceId: receipt.resourceId,
          action: receipt.action,
          name: receipt.name,
        }
      }
      return createResourcePackageApplyTx({
        currentAuthority: input.currentAuthority,
        agents: createAgentPackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'agent'),
        ),
        skills: createSkillPackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'skill'),
        ),
        mcps: createMcpPackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'mcp'),
        ),
        plugins: createPluginPackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'plugin'),
        ),
        workflows: createWorkflowPackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'workflow'),
        ),
        workgroups: createWorkgroupPackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'workgroup'),
        ),
        capabilityTemplates: createCapabilityTemplatePackageMutationParticipantInTx((prepared) =>
          commitCapability(prepared, 'capability_template'),
        ),
        events: createResourcePackageEventsInTx((_receipt) => {}),
        audit: createResourcePackageAuditInTx((_receipt) => {}),
      })
    },
    rollForwardCommitted(log) {
      rollForwardSkillTails(
        db,
        appHome,
        {
          skillStages: [...skillStages.values()],
          skillVersionStages: [...skillVersionStages.values()],
        },
        log,
        dependencies,
      )
    },
    broadcastCommitted() {
      for (const row of createdWorkflowRows) {
        try {
          dependencies.broadcastWorkflowCreated(dependencies.rowToWorkflowDetail(row))
        } catch {
          // Existing behavior: broadcasts are fire-and-forget.
        }
      }
      for (const workgroup of createdWorkgroups) {
        try {
          dependencies.broadcastWorkgroupCreated(workgroup)
        } catch {
          // Existing behavior: broadcasts are fire-and-forget.
        }
      }
    },
  }
}

export function rollForwardLegacyResourcePackageArtifacts(
  db: DbClient,
  appHome: string,
  artifacts: readonly ResourcePackageMutationArtifact[],
  log: Logger,
  dependencies: LegacyResourcePackageMutationDependencies,
): void {
  rollForwardSkillTails(
    db,
    appHome,
    {
      skillStages: artifacts.flatMap((artifact) =>
        artifact.kind === 'skill-stage' ? [{ skillId: artifact.skillId, opId: artifact.opId }] : [],
      ),
      skillVersionStages: artifacts.flatMap((artifact) =>
        artifact.kind === 'skill-version-stage' ? [artifact.staged] : [],
      ),
    },
    log,
    dependencies,
  )
}

export function compensateLegacyResourcePackageArtifact(
  db: DbClient,
  artifact: ResourcePackageMutationArtifact,
  dependencies: LegacyResourcePackageMutationDependencies,
): void {
  switch (artifact.kind) {
    case 'skill-stage':
      dependencies.compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage':
      dependencies.abortStagedSkillVersion(db, artifact.staged)
      return
    case 'plugin-install':
      rmSync(artifact.generationDir, { recursive: true, force: true })
  }
}

function skillPayload(operation: ResourcePackageMutationOperation): {
  name: string
  description: string
} {
  return operation.payload as { name: string; description: string }
}

function skillExpectOf(operation: ResourcePackageMutationOperation): {
  expectedVersion?: number
  expectedMetaRevision?: number
} {
  const expect = operation.expect as
    | { expectedContentVersion?: number; expectedMetaRevision?: number }
    | undefined
  if (expect === undefined) return {}
  return {
    ...(expect.expectedContentVersion === undefined
      ? {}
      : { expectedVersion: expect.expectedContentVersion }),
    ...(expect.expectedMetaRevision === undefined
      ? {}
      : { expectedMetaRevision: expect.expectedMetaRevision }),
  }
}

function writeSkillTree(
  filesDir: string,
  operation: ResourcePackageMutationOperation,
  readSkillFile: (ref: string) => Uint8Array,
): void {
  const payload = operation.payload as {
    name: string
    description: string
    frontmatterExtra: Record<string, unknown>
    bodyMd: string
    files: Array<{ path: string; ref: string }>
  }
  const skillMd = `---\n${stringifyYaml(
    { name: payload.name, description: payload.description, ...payload.frontmatterExtra },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
  writeFileSync(join(filesDir, 'SKILL.md'), skillMd)
  for (const file of payload.files) {
    const absolutePath = join(filesDir, file.path)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, readSkillFile(file.ref))
  }
}

function selectPluginRowInTx(tx: DbTxSync, id: string): typeof plugins.$inferSelect {
  const row = tx.select().from(plugins).where(eq(plugins.id, id)).get()
  if (row === undefined) throw new NotFoundError('plugin-not-found', `plugin '${id}' not found`)
  return row
}

function rollForwardSkillTails(
  db: DbClient,
  appHome: string,
  state: {
    readonly skillStages: readonly { skillId: string; opId: string }[]
    readonly skillVersionStages: readonly LegacyStagedSkillVersion[]
  },
  log: Logger,
  dependencies: LegacyResourcePackageMutationDependencies,
): void {
  const pendingSkillVersions: LegacyStagedSkillVersion[] = []
  for (const staged of state.skillVersionStages) {
    if (staged.opId === null) {
      pendingSkillVersions.push(staged)
      continue
    }
    const operation = db
      .select({ active: skillOperations.active, phase: skillOperations.phase })
      .from(skillOperations)
      .where(eq(skillOperations.opId, staged.opId))
      .get()
    if (operation?.active === 1) {
      pendingSkillVersions.push(staged)
      continue
    }
    if (operation?.phase !== 'done') {
      log.warn('bundle-skill-publish-op-not-replayable', {
        skillId: staged.skillId,
        opId: staged.opId,
        phase: operation?.phase ?? 'missing',
      })
    }
  }

  for (const staged of pendingSkillVersions) {
    dependencies.unmarkSkillBootVerified(staged.skillId)
  }
  for (const staged of pendingSkillVersions) {
    try {
      dependencies.publishStagedSkillVersion(db, { appHome }, staged)
    } catch (error) {
      log.warn('bundle-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const stage of state.skillStages) {
    try {
      dbTxSync(db, (tx) => dependencies.finishOperation(tx, stage.opId))
    } catch (error) {
      log.warn('bundle-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
