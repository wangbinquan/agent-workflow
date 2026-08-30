// RFC-345 T6 — compatibility participants for the current BundleApply lifecycle.
//
// BundleApply still owns claim/journal/pre-stage ordering/big-tx/roll-forward/recovery until W6.
// This adapter owns the seven aggregate-specific prepare/commit arms so the lifecycle engine no
// longer reaches into seven legacy writers directly. The public participant contract stays free of
// Actor/SQLite/filesystem values; these imports are deliberately confined to infrastructure.

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
import {
  commitTemplateInTx,
  prepareTemplateFromBundle,
  type PreparedTemplateWrite,
} from '@/services/capabilityTemplates'
import {
  commitAgentCreateInTx,
  commitAgentUpdateInTx,
  getAgentById,
  prepareAgentCreate,
  prepareAgentUpdate,
  type PreparedAgentCreate,
  type PreparedAgentUpdate,
} from '@/services/agent'
import {
  commitMcpCreateInTx,
  commitMcpUpdateInTx,
  getMcpById,
  prepareMcpCreate,
  type PreparedMcpCreate,
  type PreparedMcpUpdate,
} from '@/services/mcp'
import { commitPluginCreateInTx, commitPluginPublishInTx } from '@/services/plugin'
import { installPlugin, plannedGenerationDir, type InstallResult } from '@/services/pluginInstaller'
import { getAclResourceOwnerInTx, initialPrivateResourceAcl } from '@/services/resourceAcl'
import {
  assertRefsUsableInTx,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from '@/services/resourceRefs'
import {
  commitSkillReadyInTx,
  compensateManagedSkillStage,
  stageManagedSkill,
} from '@/services/skill'
import { unmarkSkillBootVerified } from '@/services/skillBootVerify'
import { finishOperation } from '@/services/skillOperations'
import {
  abortStagedSkillVersion,
  commitSkillVersionInTx,
  publishStagedSkillVersion,
  stageSkillVersion,
  type StagedSkillVersion,
} from '@/services/skillVersion'
import {
  broadcastWorkflowCreated,
  commitWorkflowSaveInTx,
  insertWorkflowInTx,
  prepareWorkflowSave,
  rowToWorkflowDetail,
  type PreparedWorkflowSave,
} from '@/services/workflow'
import {
  broadcastWorkgroupCreated,
  commitWorkgroupCreateInTx,
  commitWorkgroupSaveInTx,
  prepareWorkgroupCreate,
  prepareWorkgroupSave,
  type PreparedWorkgroupCreate,
  type PreparedWorkgroupSave,
} from '@/services/workgroups'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import type { Logger } from '@/util/log'
import { monotonicNow } from '@/util/time'

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
      prepared: PreparedAgentCreate
    }
  | {
      op: AgentOperation
      resourceType: 'agent'
      kind: 'agent-update'
      prepared: PreparedAgentUpdate
    }
  | { op: McpOperation; resourceType: 'mcp'; kind: 'mcp-create'; prepared: PreparedMcpCreate }
  | { op: McpOperation; resourceType: 'mcp'; kind: 'mcp-update'; prepared: PreparedMcpUpdate }
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
      prepared: PreparedWorkflowSave
    }
  | {
      op: WorkgroupOperation
      resourceType: 'workgroup'
      kind: 'workgroup-create'
      prepared: PreparedWorkgroupCreate
    }
  | {
      op: WorkgroupOperation
      resourceType: 'workgroup'
      kind: 'workgroup-update'
      prepared: PreparedWorkgroupSave
    }
  | {
      op: CapabilityTemplateOperation
      resourceType: 'capability_template'
      kind: 'capability-template'
      prepared: PreparedTemplateWrite
    }

export type ResourcePackageMutationArtifact =
  | { kind: 'skill-stage'; skillId: string; opId: string; skillDir: string }
  | { kind: 'skill-version-stage'; staged: StagedSkillVersion }
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
  prepare(
    operation: ResourcePackageMutationOperation,
    context: ResourcePackageMutationPreparationContext,
  ): Promise<PreparedResourcePackageMutation>
  prestage(
    prepared: PreparedResourcePackageMutation,
    context: ResourcePackageMutationPrestageContext,
  ): Promise<void>
  assertUpdateTargetsOwnedInTx(
    tx: DbTxSync,
    operations: readonly ResourcePackageMutationOperation[],
  ): void
  commitInTx(
    tx: DbTxSync,
    prepared: PreparedResourcePackageMutation,
    context: ResourcePackageMutationCommitContext,
  ): void
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

export function createLegacyResourcePackageMutationAdapter(
  options: LegacyResourcePackageMutationAdapterOptions,
): LegacyResourcePackageMutationAdapter {
  const { db, appHome, actor } = options
  const pluginInstalls = new Map<string, InstallResult>()
  const skillStages = new Map<string, { skillId: string; opId: string; skillDir: string }>()
  const skillVersionStages = new Map<string, StagedSkillVersion>()
  const createdWorkflowRows: Array<ReturnType<typeof insertWorkflowInTx>> = []
  const createdWorkgroups: Array<ReturnType<typeof commitWorkgroupCreateInTx>> = []

  const participants: LegacyResourcePackageMutationParticipants = {
    agents: {
      async prepare(operation, context) {
        if (operation.kind === 'agent-create') {
          const parsed = CreateAgentSchema.parse(operation.payload)
          const prepared = await prepareAgentCreate(db, parsed, {
            ownerUserId: actor.user.id,
            actor,
            id: operation.resourceId,
            pendingBundleIds: context.pendingIds,
          })
          return { op: operation, resourceType: 'agent', kind: 'agent-create', prepared }
        }
        const existing = await getAgentById(db, operation.resourceId)
        if (existing === null) throw new NotFoundError('agent-not-found', 'agent not found')
        const { name: _name, ...patchBody } = operation.payload
        const patch = UpdateAgentSchema.parse(patchBody)
        const expect = operation.expect as {
          expectedUpdatedAt: number
          expectedAclRevision: number
        }
        const prepared = await prepareAgentUpdate(db, operation.resourceId, patch, actor, expect, {
          pendingBundleIds: context.pendingIds,
        })
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
          const prepared = await prepareMcpCreate(db, parsed, {
            ownerUserId: actor.user.id,
            actor,
          })
          return {
            op: operation,
            resourceType: 'mcp',
            kind: 'mcp-create',
            prepared: { ...prepared, id: operation.resourceId },
          }
        }
        const existing = await getMcpById(db, operation.resourceId)
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
        const prepared = await prepareWorkflowSave(
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
          const prepared = await prepareWorkgroupCreate(db, parsed, {
            ownerUserId: actor.user.id,
            actor,
            pendingAgentNames: context.pendingAgentNames,
          })
          return {
            op: operation,
            resourceType: 'workgroup',
            kind: 'workgroup-create',
            prepared: { ...prepared, groupId: operation.resourceId },
          }
        }
        const expect = operation.expect as { expectedVersion: number }
        const prepared = await prepareWorkgroupSave(
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
        const prepared = await prepareTemplateFromBundle(
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
    async prepare(operation, context) {
      switch (operation.resourceType) {
        case 'agent':
          return participants.agents.prepare(operation as AgentOperation, context)
        case 'skill':
          return participants.skills.prepare(operation as SkillOperation)
        case 'mcp':
          return participants.mcps.prepare(operation as McpOperation)
        case 'plugin':
          return participants.plugins.prepare(operation as PluginOperation)
        case 'workflow':
          return participants.workflows.prepare(operation as WorkflowOperation, context)
        case 'workgroup':
          return participants.workgroups.prepare(operation as WorkgroupOperation, context)
        case 'capability_template':
          return participants.capabilityTemplates.prepare(operation as CapabilityTemplateOperation)
      }
    },
    async prestage(prepared, context) {
      if (prepared.kind === 'plugin-create' || prepared.kind === 'plugin-update') {
        const generationId = ulid()
        const generationDir = plannedGenerationDir(
          prepared.op.resourceId,
          prepared.spec,
          generationId,
          options.pluginInstallOpts?.pluginsDir,
        )
        if (generationDir !== null) {
          context.recordArtifact({
            kind: 'plugin-install',
            pluginId: prepared.op.resourceId,
            generationId,
            generationDir,
          })
        }
        const install = await installPlugin(prepared.op.resourceId, prepared.spec, {
          ...options.pluginInstallOpts,
          generationId,
        })
        pluginInstalls.set(prepared.op.opId, install)
        options.afterPluginInstall?.()
        return
      }
      if (prepared.kind === 'skill-create') {
        const stage = await stageManagedSkill(
          db,
          { appHome },
          {
            name: skillPayload(prepared.op).name,
            description: skillPayload(prepared.op).description,
            ownerUserId: actor.user.id,
            actor,
            id: prepared.op.resourceId,
          },
          (filesDir) => writeSkillTree(filesDir, prepared.op, context.readSkillFile),
        )
        skillStages.set(prepared.op.opId, stage)
        context.recordArtifact({ kind: 'skill-stage', ...stage })
        options.afterSkillStage?.()
        return
      }
      if (prepared.kind === 'skill-update') {
        const staged = stageSkillVersion(
          db,
          { appHome },
          prepared.op.resourceId,
          (stagingDir) => writeSkillTree(stagingDir, prepared.op, context.readSkillFile),
          {
            source: 'import',
            authorUserId: actor.user.id,
            ...skillExpectOf(prepared.op),
            expectedOwnerUserId: actor.user.id,
            setDescription: skillPayload(prepared.op).description,
          },
        )
        skillVersionStages.set(prepared.op.opId, staged)
        context.recordArtifact({ kind: 'skill-version-stage', staged })
        options.afterSkillStage?.()
      }
    },
    assertUpdateTargetsOwnedInTx(tx, operations) {
      for (const operation of operations) {
        if (operation.action !== 'update') continue
        const ownerUserId = getAclResourceOwnerInTx(
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
    commitInTx(tx, prepared, context) {
      switch (prepared.kind) {
        case 'agent-create':
          commitAgentCreateInTx(tx, prepared.prepared)
          return
        case 'agent-update':
          commitAgentUpdateInTx(tx, prepared.prepared)
          return
        case 'mcp-create':
          commitMcpCreateInTx(tx, prepared.prepared)
          return
        case 'mcp-update':
          commitMcpUpdateInTx(tx, prepared.prepared)
          return
        case 'plugin-create': {
          const install = pluginInstalls.get(prepared.op.opId)
          if (install === undefined) throw new Error('plugin install result missing')
          commitPluginCreateInTx(tx, {
            id: prepared.op.resourceId,
            parsed: prepared.parsed as never,
            initialAcl: initialPrivateResourceAcl(actor.user.id),
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
          commitPluginPublishInTx(tx, captured, {
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
          commitSkillReadyInTx(tx, { skillId: stage.skillId, opId: stage.opId })
          return
        }
        case 'skill-update': {
          const staged = skillVersionStages.get(prepared.op.opId)
          if (staged === undefined) throw new Error('skill version stage missing')
          commitSkillVersionInTx(tx, staged, {
            source: 'import',
            authorUserId: actor.user.id,
            setDescription: skillPayload(prepared.op).description,
          })
          return
        }
        case 'workflow-create': {
          assertRefsUsableInTx(tx, actor, [
            {
              type: 'agent',
              domain: 'id',
              names: (prepared.definition.nodes ?? [])
                .filter((node) => node.kind === 'agent-single' && typeof node.agentId === 'string')
                .map((node) => node.agentId as string),
            },
            {
              type: 'workflow',
              names: extractWorkflowWorkflowRefs(prepared.definition).filter(
                (name) => !context.bundleCreatedNames.workflow.has(name),
              ),
              domain: 'name',
            },
            {
              type: 'workgroup',
              names: extractWorkflowWorkgroupRefs(prepared.definition).filter(
                (name) => !context.bundleCreatedNames.workgroup.has(name),
              ),
              domain: 'name',
            },
          ])
          const payload = prepared.op.payload as { name: string; description: string }
          createdWorkflowRows.push(
            insertWorkflowInTx(tx, {
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
          const result = commitWorkflowSaveInTx(tx, prepared.prepared)
          if (!result.committed && result.receipt.outcome !== 'already-current') {
            throw new ConflictError('bundle-baseline-stale', 'workflow save did not commit')
          }
          return
        }
        case 'workgroup-create':
          createdWorkgroups.push(commitWorkgroupCreateInTx(tx, prepared.prepared))
          return
        case 'workgroup-update': {
          const result = commitWorkgroupSaveInTx(tx, prepared.prepared)
          if (!result.committed && result.receipt.outcome !== 'already-current') {
            throw new ConflictError('bundle-baseline-stale', 'workgroup save did not commit')
          }
          return
        }
        case 'capability-template':
          commitTemplateInTx(tx, prepared.prepared)
      }
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
      )
    },
    broadcastCommitted() {
      for (const row of createdWorkflowRows) {
        try {
          broadcastWorkflowCreated(rowToWorkflowDetail(row))
        } catch {
          // Existing behavior: broadcasts are fire-and-forget.
        }
      }
      for (const workgroup of createdWorkgroups) {
        try {
          broadcastWorkgroupCreated(workgroup)
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
  )
}

export function compensateLegacyResourcePackageArtifact(
  db: DbClient,
  artifact: ResourcePackageMutationArtifact,
): void {
  switch (artifact.kind) {
    case 'skill-stage':
      compensateManagedSkillStage(db, artifact)
      return
    case 'skill-version-stage':
      abortStagedSkillVersion(db, artifact.staged)
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
    readonly skillVersionStages: readonly StagedSkillVersion[]
  },
  log: Logger,
): void {
  const pendingSkillVersions: StagedSkillVersion[] = []
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

  for (const staged of pendingSkillVersions) unmarkSkillBootVerified(staged.skillId)
  for (const staged of pendingSkillVersions) {
    try {
      publishStagedSkillVersion(db, { appHome }, staged)
    } catch (error) {
      log.warn('bundle-skill-publish-replayed-or-failed', {
        skillId: staged.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
  for (const stage of state.skillStages) {
    try {
      dbTxSync(db, (tx) => finishOperation(tx, stage.opId))
    } catch (error) {
      log.warn('bundle-skill-finish-replayed-or-failed', {
        skillId: stage.skillId,
        err: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
