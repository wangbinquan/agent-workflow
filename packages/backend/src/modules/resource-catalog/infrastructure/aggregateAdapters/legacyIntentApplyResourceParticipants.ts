// RFC-345 T4b — exact resource-catalog participant for the current Intent lifecycle.
//
// Intent still owns claim/journal/prestage ordering/the big transaction/finalize/convergence.
// This compatibility adapter owns only the six aggregate-specific prepare/commit arms and keeps
// every prepared value private to one apply session.  The legacy implementations arrive through
// a composition-injected port, so this module never imports the compatibility service layer.

import {
  CreateAgentSchema,
  CreateMcpSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  WorkgroupDraftSnapshotSchema,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  type CreateMcp,
  type UpdateWorkflow,
  type UpdateWorkgroup,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { stringify as stringifyYaml } from 'yaml'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ulid } from 'ulid'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { DbTxSync } from '@/db/txSync'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import { createIntentApplyResourceParticipantInTx } from '../../application/participants/intentApplyResourceParticipant'
import type {
  IntentApplyResourceParticipantInTx,
  ResourceRequestContext,
} from '../../public/participants'
import type {
  IntentResourceChangesetReceipt,
  ResourceSummaryRevision,
  VersionedIntentResourceChangesetPlan,
} from '../../public/types'
import type { CatalogSelectorKind } from '../../domain/resourceKinds'

type PlanOf<K extends CatalogSelectorKind> = Extract<
  VersionedIntentResourceChangesetPlan,
  { readonly kind: K }
>
type CreatePlanOf<K extends CatalogSelectorKind> = Extract<PlanOf<K>, { readonly action: 'create' }>
type UpdatePlanOf<K extends CatalogSelectorKind> = Extract<PlanOf<K>, { readonly action: 'update' }>
type ReceiptOf<K extends CatalogSelectorKind> = Extract<
  IntentResourceChangesetReceipt,
  { readonly kind: K }
>

export interface LegacyIntentPluginRow {
  readonly id: string
  readonly name: string
  readonly spec: string
  readonly optionsJson: string
  readonly description: string
  readonly enabled: boolean
  readonly sourceKind: 'npm' | 'git' | 'file'
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly installedAt: number
  readonly ownerUserId: string | null
  readonly visibility: 'private' | 'public'
  readonly aclRevision: number
  readonly schemaVersion: number
  readonly createdAt: number
  readonly updatedAt: number
}

export interface LegacyIntentPluginInstallResult {
  readonly generationDir: string | null
  readonly sourceKind: 'npm' | 'git' | 'file'
  readonly cachedPath: string
  readonly resolvedVersion: string | null
  readonly sourceIdentity: string | null
  readonly manifest: Readonly<{
    readonly version: 1
    readonly pluginId: string
    readonly opId: string
    readonly sourceKind: 'npm' | 'git'
    readonly requestedSpec: string
    readonly entryRelativePath: string
    readonly resolvedVersion: string | null
    readonly sourceIdentity: string
    readonly resolved: string
    readonly integrity: string | null
    readonly commit: string | null
    readonly completed: true
    readonly createdAt: number
  }> | null
}

export interface LegacyIntentStagedSkillVersion {
  readonly skillId: string
  readonly skillName: string
  readonly opId: string | null
  readonly publishId: string
  readonly newVersion: number
  readonly newHash: string
  readonly filesDir: string
  readonly versionDir: string
  readonly stagingDir: string
  readonly noop: Readonly<{
    readonly id: string
    readonly skillId: string
    readonly source: 'initial' | 'import' | 'editor' | 'fusion' | 'restore'
    readonly versionIndex: number
    readonly summary: string | null
    readonly fusionId: string | null
    readonly restoredFromVersion: number | null
    readonly authorUserId: string | null
    readonly contentHash: string | null
    readonly filesPath: string
    readonly createdAt: number
  }> | null
}

export type LegacyIntentApplyArtifact =
  | {
      readonly kind: 'plugin-install'
      readonly pluginId: string
      readonly generationId: string
      readonly generationDir: string
    }
  | {
      readonly kind: 'skill-stage'
      readonly skillId: string
      readonly opId: string
      readonly skillDir: string
    }
  | {
      readonly kind: 'skill-version-stage'
      readonly staged: LegacyIntentStagedSkillVersion
    }

export interface LegacyIntentApplyResourceDependencies {
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
  readonly getAgentById: (
    db: DbClient,
    id: string,
  ) => Promise<
    | (Readonly<Record<string, unknown>> & {
        readonly name: string
      })
    | null
  >
  readonly prepareAgentUpdate: (
    db: DbClient,
    id: string,
    patch: ReturnType<typeof UpdateAgentSchema.parse>,
    actor: Actor,
    fence: { readonly expectedUpdatedAt: number; readonly expectedAclRevision: number },
    options: { readonly pendingBundleIds: ReadonlySet<string> },
  ) => Promise<unknown>
  readonly commitAgentCreateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly commitAgentUpdateInTx: (tx: DbTxSync, prepared: unknown) => void

  readonly prepareMcpCreate: (
    db: DbClient,
    input: CreateMcp,
    options: { readonly ownerUserId: string; readonly actor: Actor },
  ) => Promise<unknown>
  readonly getMcpById: (
    db: DbClient,
    id: string,
  ) => Promise<{
    readonly type: 'local' | 'remote'
    readonly config: Readonly<Record<string, unknown>>
    readonly updatedAt: number
    readonly ownerUserId: string | null
  } | null>
  readonly commitMcpCreateInTx: (tx: DbTxSync, prepared: unknown) => void
  readonly commitMcpUpdateInTx: (tx: DbTxSync, prepared: unknown) => void

  readonly getPluginById: (db: DbClient, id: string) => Promise<LegacyIntentPluginRow | null>
  readonly pluginOperationConfigHashOf: (row: LegacyIntentPluginRow) => string
  readonly commitPluginCreateInTx: (
    tx: DbTxSync,
    input: {
      readonly id: string
      readonly parsed: {
        readonly name: string
        readonly spec: string
        readonly options: Readonly<Record<string, unknown>>
        readonly description: string
        readonly enabled: boolean
      }
      readonly initialAcl: {
        readonly ownerUserId: string
        readonly visibility: 'private'
        readonly aclRevision: 0
      }
      readonly install: LegacyIntentPluginInstallResult
      readonly now: number
    },
  ) => void
  readonly commitPluginPublishInTx: (
    tx: DbTxSync,
    captured: LegacyIntentPluginRow,
    input: {
      readonly spec: string
      readonly optionsJson: string
      readonly description: string
      readonly enabled: boolean
      readonly sourceKind: 'npm' | 'git' | 'file'
      readonly cachedPath: string
      readonly resolvedVersion: string | null
      readonly installedAt: number
      readonly updatedAt: number
    },
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
  ) => Promise<LegacyIntentPluginInstallResult>

  readonly stageManagedSkill: (
    db: DbClient,
    options: { readonly appHome: string },
    input: {
      readonly name: string
      readonly description: string
      readonly ownerUserId: string
      readonly actor: Actor
      readonly id: string
    },
    produce: (filesDir: string) => void,
  ) => Promise<{ readonly skillId: string; readonly opId: string; readonly skillDir: string }>
  readonly stageSkillVersion: (
    db: DbClient,
    options: { readonly appHome: string },
    skillId: string,
    produce: (stagingDir: string) => void,
    commit: {
      readonly source: 'editor'
      readonly authorUserId: string
      readonly expectedOwnerUserId: string
      readonly setDescription: string
    },
  ) => LegacyIntentStagedSkillVersion
  readonly commitSkillReadyInTx: (
    tx: DbTxSync,
    input: { readonly skillId: string; readonly opId: string },
  ) => void
  readonly commitSkillVersionInTx: (
    tx: DbTxSync,
    staged: LegacyIntentStagedSkillVersion,
    commit: {
      readonly source: 'editor'
      readonly authorUserId: string
      readonly expectedOwnerUserId: string
      readonly setDescription: string
    },
  ) => void

  readonly prepareWorkflowSave: (
    db: DbClient,
    id: string,
    input: UpdateWorkflow,
    principal: { readonly kind: 'actor'; readonly actor: Actor },
  ) => Promise<unknown>
  readonly insertWorkflowInTx: (
    tx: DbTxSync,
    input: {
      readonly scriptPrincipal: { readonly kind: 'actor'; readonly actor: Actor }
      readonly id: string
      readonly name: string
      readonly description: string
      readonly definition: WorkflowDefinition
      readonly ownerUserId: string
      readonly builtin: false
      readonly now: number
    },
  ) => unknown
  readonly commitWorkflowSaveInTx: (
    tx: DbTxSync,
    prepared: unknown,
  ) => { readonly receipt: { readonly outcome: string }; readonly committed: boolean }
  readonly broadcastWorkflowCreated: (row: unknown) => void

  readonly prepareWorkgroupCreate: (
    db: DbClient,
    input: ReturnType<typeof CreateWorkgroupSchema.parse>,
    options: {
      readonly ownerUserId: string
      readonly actor: Actor
      readonly pendingAgentNames: ReadonlyMap<string, string>
    },
  ) => Promise<unknown>
  readonly prepareWorkgroupSave: (
    db: DbClient,
    id: string,
    input: UpdateWorkgroup,
    principal: { readonly kind: 'actor'; readonly actor: Actor },
  ) => Promise<unknown>
  readonly commitWorkgroupCreateInTx: (tx: DbTxSync, prepared: unknown) => unknown
  readonly commitWorkgroupSaveInTx: (
    tx: DbTxSync,
    prepared: unknown,
  ) => { readonly receipt: { readonly outcome: string }; readonly committed: boolean }
  readonly broadcastWorkgroupCreated: (row: unknown) => void

  readonly assertRefsUsableInTx: (
    tx: DbTxSync,
    actor: Actor,
    requests: readonly {
      readonly type: 'agent' | 'workflow' | 'workgroup'
      readonly names: readonly string[]
      readonly domain: 'id' | 'name'
    }[],
  ) => void
  readonly extractWorkflowWorkflowRefs: (definition: WorkflowDefinition) => string[]
  readonly extractWorkflowWorkgroupRefs: (definition: WorkflowDefinition) => string[]
  readonly resourceRevisionInTx: <K extends CatalogSelectorKind>(
    tx: DbTxSync,
    kind: K,
    resourceId: string,
  ) => ResourceSummaryRevision<K>
}

type PreparedMutation =
  | { readonly plan: CreatePlanOf<'agent'>; readonly kind: 'agent-create'; prepared: unknown }
  | { readonly plan: UpdatePlanOf<'agent'>; readonly kind: 'agent-update'; prepared: unknown }
  | { readonly plan: CreatePlanOf<'mcp'>; readonly kind: 'mcp-create'; prepared: unknown }
  | { readonly plan: UpdatePlanOf<'mcp'>; readonly kind: 'mcp-update'; prepared: unknown }
  | {
      readonly plan: CreatePlanOf<'plugin'>
      readonly kind: 'plugin-create'
      readonly spec: string
      readonly parsed: {
        readonly name: string
        readonly spec: string
        readonly options: Readonly<Record<string, unknown>>
        readonly description: string
        readonly enabled: boolean
      }
    }
  | { readonly plan: CreatePlanOf<'skill'>; readonly kind: 'skill-create' }
  | { readonly plan: UpdatePlanOf<'skill'>; readonly kind: 'skill-update' }
  | {
      readonly plan: UpdatePlanOf<'plugin'>
      readonly kind: 'plugin-update'
      readonly spec: string
      readonly specChanged: boolean
      readonly captured: LegacyIntentPluginRow
      readonly payload: {
        readonly options: Readonly<Record<string, unknown>>
        readonly description: string
        readonly enabled: boolean
      }
    }
  | {
      readonly plan: CreatePlanOf<'workflow'>
      readonly kind: 'workflow-create'
      readonly definition: WorkflowDefinition
    }
  | { readonly plan: UpdatePlanOf<'workflow'>; readonly kind: 'workflow-update'; prepared: unknown }
  | {
      readonly plan: CreatePlanOf<'workgroup'>
      readonly kind: 'workgroup-create'
      prepared: unknown
    }
  | {
      readonly plan: UpdatePlanOf<'workgroup'>
      readonly kind: 'workgroup-update'
      prepared: unknown
    }

export interface LegacyIntentApplyPrepareContext {
  readonly pendingIds: ReadonlySet<string>
  readonly pendingAgentNames: ReadonlyMap<string, string>
  readonly clientMutationId: string
}

export interface LegacyIntentApplyPrestageContext {
  readonly recordArtifact: (artifact: LegacyIntentApplyArtifact) => void
}

export interface LegacyIntentApplyCommitContext {
  readonly bundleCreatedNames: {
    readonly workflow: ReadonlySet<string>
    readonly workgroup: ReadonlySet<string>
  }
}

export interface LegacyIntentApplyResourceSession {
  prepare(
    plan: VersionedIntentResourceChangesetPlan,
    context: LegacyIntentApplyPrepareContext,
  ): Promise<void>
  prestage(
    plan: VersionedIntentResourceChangesetPlan,
    context: LegacyIntentApplyPrestageContext,
  ): Promise<void>
  participantInTransaction(
    tx: DbTxSync,
    context: LegacyIntentApplyCommitContext,
  ): IntentApplyResourceParticipantInTx
  broadcastCommitted(): void
}

export interface LegacyIntentApplyResourceSessionOptions {
  readonly db: DbClient
  readonly appHome: string
  readonly actor: Actor
  readonly authority: ResourceRequestContext
  readonly pluginInstallOpts?: {
    readonly pluginsDir?: string
    readonly npmBin?: string
    readonly timeoutMs?: number
  }
  readonly afterPluginInstall?: () => void
  readonly afterSkillStage?: () => void
}

function skillPayload(plan: PlanOf<'skill'>): {
  readonly name: string
  readonly description: string
  readonly frontmatterExtra: Readonly<Record<string, unknown>>
  readonly bodyMd: string
  readonly files: readonly { readonly path: string; readonly content: string }[]
} {
  return {
    name: plan.payload.name,
    description: plan.payload.description,
    frontmatterExtra: plan.payload.frontmatterExtra ?? {},
    bodyMd: plan.payload.bodyMd,
    files: plan.payload.files,
  }
}

function writeSkillTree(root: string, payload: ReturnType<typeof skillPayload>): void {
  const skillMd = `---\n${stringifyYaml(
    {
      name: payload.name,
      description: payload.description,
      ...payload.frontmatterExtra,
    },
    { lineWidth: 0 },
  )}---\n\n${payload.bodyMd}\n`
  writeFileSync(join(root, 'SKILL.md'), skillMd)
  for (const file of payload.files) {
    const absolute = join(root, file.path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, file.content)
  }
}

export function createLegacyIntentApplyResourceSession(
  options: LegacyIntentApplyResourceSessionOptions,
  dependencies: LegacyIntentApplyResourceDependencies,
): LegacyIntentApplyResourceSession {
  const { db, appHome, actor } = options
  const preparedByOperationId = new Map<string, PreparedMutation>()
  const pluginInstalls = new Map<string, LegacyIntentPluginInstallResult>()
  const skillStages = new Map<
    string,
    { readonly skillId: string; readonly opId: string; readonly skillDir: string }
  >()
  const skillVersionStages = new Map<string, LegacyIntentStagedSkillVersion>()
  const createdWorkflowRows: unknown[] = []
  const createdWorkgroups: unknown[] = []

  const remember = (prepared: PreparedMutation): void => {
    if (preparedByOperationId.has(prepared.plan.operationId)) {
      throw new Error(`duplicate intent resource operation ${prepared.plan.operationId}`)
    }
    preparedByOperationId.set(prepared.plan.operationId, prepared)
  }

  const requirePrepared = <K extends CatalogSelectorKind>(plan: PlanOf<K>): PreparedMutation => {
    const prepared = preparedByOperationId.get(plan.operationId)
    if (prepared === undefined || prepared.plan !== plan || prepared.plan.kind !== plan.kind) {
      throw new Error('foreign-intent-resource-plan')
    }
    return prepared
  }

  const commit = <K extends CatalogSelectorKind>(
    tx: DbTxSync,
    context: LegacyIntentApplyCommitContext,
    authority: ResourceRequestContext,
    plan: PlanOf<K>,
  ): ReceiptOf<K> => {
    if (authority !== options.authority) throw new Error('foreign-intent-apply-authority')
    const prepared = requirePrepared(plan)
    switch (prepared.kind) {
      case 'agent-create':
        dependencies.commitAgentCreateInTx(tx, prepared.prepared)
        break
      case 'agent-update':
        dependencies.commitAgentUpdateInTx(tx, prepared.prepared)
        break
      case 'mcp-create':
        dependencies.commitMcpCreateInTx(tx, prepared.prepared)
        break
      case 'mcp-update':
        dependencies.commitMcpUpdateInTx(tx, prepared.prepared)
        break
      case 'plugin-create': {
        const install = pluginInstalls.get(plan.operationId)
        if (install === undefined) throw new Error('plugin install result missing')
        dependencies.commitPluginCreateInTx(tx, {
          id: plan.resourceId,
          parsed: prepared.parsed,
          initialAcl: {
            ownerUserId: actor.user.id,
            visibility: 'private',
            aclRevision: 0,
          },
          install,
          now: Date.now(),
        })
        break
      }
      case 'plugin-update': {
        const install = pluginInstalls.get(plan.operationId)
        dependencies.commitPluginPublishInTx(tx, prepared.captured, {
          spec: prepared.spec,
          optionsJson: JSON.stringify(prepared.payload.options),
          description: prepared.payload.description,
          enabled: prepared.payload.enabled,
          sourceKind: install?.sourceKind ?? prepared.captured.sourceKind,
          cachedPath: install?.cachedPath ?? prepared.captured.cachedPath,
          resolvedVersion: install?.resolvedVersion ?? prepared.captured.resolvedVersion,
          installedAt: install === undefined ? prepared.captured.installedAt : Date.now(),
          updatedAt: monotonicNow(prepared.captured.updatedAt),
        })
        break
      }
      case 'skill-create': {
        const stage = skillStages.get(plan.operationId)
        if (stage === undefined) throw new Error('skill stage missing')
        dependencies.commitSkillReadyInTx(tx, { skillId: stage.skillId, opId: stage.opId })
        break
      }
      case 'skill-update': {
        const staged = skillVersionStages.get(plan.operationId)
        if (staged === undefined) throw new Error('skill version stage missing')
        dependencies.commitSkillVersionInTx(tx, staged, {
          source: 'editor',
          authorUserId: actor.user.id,
          expectedOwnerUserId: actor.user.id,
          setDescription: skillPayload(prepared.plan).description,
        })
        break
      }
      case 'workflow-create': {
        dependencies.assertRefsUsableInTx(tx, actor, [
          {
            type: 'agent',
            domain: 'id',
            names: (prepared.definition.nodes ?? [])
              .filter((node) => node.kind === 'agent-single' && typeof node.agentId === 'string')
              .map((node) => node.agentId as string),
          },
          {
            type: 'workflow',
            domain: 'name',
            names: dependencies
              .extractWorkflowWorkflowRefs(prepared.definition)
              .filter((name) => !context.bundleCreatedNames.workflow.has(name)),
          },
          {
            type: 'workgroup',
            domain: 'name',
            names: dependencies
              .extractWorkflowWorkgroupRefs(prepared.definition)
              .filter((name) => !context.bundleCreatedNames.workgroup.has(name)),
          },
        ])
        const payload = prepared.plan.payload
        createdWorkflowRows.push(
          dependencies.insertWorkflowInTx(tx, {
            scriptPrincipal: { kind: 'actor', actor },
            id: prepared.plan.resourceId,
            name: payload.name,
            description: payload.description,
            definition: prepared.definition,
            ownerUserId: actor.user.id,
            builtin: false,
            now: Date.now(),
          }),
        )
        break
      }
      case 'workflow-update': {
        const result = dependencies.commitWorkflowSaveInTx(tx, prepared.prepared)
        if (!result.committed && result.receipt.outcome !== 'already-current') {
          throw new ConflictError('intent-baseline-stale', 'workflow save did not commit')
        }
        break
      }
      case 'workgroup-create':
        createdWorkgroups.push(dependencies.commitWorkgroupCreateInTx(tx, prepared.prepared))
        break
      case 'workgroup-update': {
        const result = dependencies.commitWorkgroupSaveInTx(tx, prepared.prepared)
        if (!result.committed && result.receipt.outcome !== 'already-current') {
          throw new ConflictError('intent-baseline-stale', 'workgroup save did not commit')
        }
        break
      }
    }
    return Object.freeze({
      kind: plan.kind,
      operationId: plan.operationId,
      resourceId: plan.resourceId,
      action: plan.action,
      revision: dependencies.resourceRevisionInTx(tx, plan.kind, plan.resourceId),
    }) as unknown as ReceiptOf<K>
  }

  const session: LegacyIntentApplyResourceSession = {
    async prepare(plan, context) {
      switch (plan.kind) {
        case 'agent': {
          if (plan.action === 'create') {
            const parsed = CreateAgentSchema.parse(plan.payload)
            remember({
              plan,
              kind: 'agent-create',
              prepared: await dependencies.prepareAgentCreate(db, parsed, {
                ownerUserId: actor.user.id,
                actor,
                id: plan.resourceId,
                pendingBundleIds: context.pendingIds,
              }),
            })
            return
          }
          const existing = await dependencies.getAgentById(db, plan.resourceId)
          if (existing === null) throw new NotFoundError('agent-not-found', 'agent not found')
          if (plan.payload.name !== existing.name) {
            throw new ValidationError(
              'intent-rename-unsupported',
              'renaming via intent update is not supported; use the finalName slot on a copy, or the rename flow',
            )
          }
          const { name: _name, ...patchBody } = plan.payload as Readonly<Record<string, unknown>>
          const mutablePatch = { ...patchBody }
          for (const key of [
            'branchPorts',
            'outputKinds',
            'role',
            'outputWrapperPortNames',
          ] as const) {
            if (!(key in mutablePatch) && existing[key] !== undefined) {
              mutablePatch[key] = existing[key]
            }
          }
          remember({
            plan,
            kind: 'agent-update',
            prepared: await dependencies.prepareAgentUpdate(
              db,
              plan.resourceId,
              UpdateAgentSchema.parse(mutablePatch),
              actor,
              {
                expectedUpdatedAt: plan.expectedRevision.updatedAt,
                expectedAclRevision: plan.expectedRevision.aclRevision,
              },
              { pendingBundleIds: context.pendingIds },
            ),
          })
          return
        }
        case 'mcp': {
          if (plan.action === 'create') {
            const parsed: CreateMcp = CreateMcpSchema.parse(plan.payload)
            const prepared = await dependencies.prepareMcpCreate(db, parsed, {
              ownerUserId: actor.user.id,
              actor,
            })
            remember({
              plan,
              kind: 'mcp-create',
              prepared: { ...(prepared as Readonly<Record<string, unknown>>), id: plan.resourceId },
            })
            return
          }
          const existing = await dependencies.getMcpById(db, plan.resourceId)
          if (existing === null) throw new NotFoundError('mcp-not-found', 'mcp not found')
          const payload: CreateMcp = CreateMcpSchema.parse(plan.payload)
          if (payload.type !== existing.type) {
            throw new ValidationError('mcp-type-immutable', 'mcp type cannot change')
          }
          const payloadOauth = (payload.config as { readonly oauth?: unknown }).oauth
          const existingOauth = (existing.config as { readonly oauth?: unknown }).oauth
          const nextConfig =
            payloadOauth !== undefined || existingOauth === undefined
              ? payload.config
              : { ...payload.config, oauth: existingOauth }
          remember({
            plan,
            kind: 'mcp-update',
            prepared: {
              id: plan.resourceId,
              set: {
                updatedAt: monotonicNow(existing.updatedAt),
                description: payload.description,
                enabled: payload.enabled,
                config: JSON.stringify(nextConfig),
              },
              expectedConfigHash: plan.expectedRevision.configHash,
              expectedOwnerUserId: existing.ownerUserId,
            },
          })
          return
        }
        case 'plugin': {
          const payload = plan.payload
          if (plan.action === 'create') {
            remember({
              plan,
              kind: 'plugin-create',
              spec: payload.spec,
              parsed: {
                name: payload.name,
                spec: payload.spec,
                options: payload.optionsJson ?? {},
                description: payload.description,
                enabled: payload.enabled ?? true,
              },
            })
            return
          }
          const captured = await dependencies.getPluginById(db, plan.resourceId)
          if (captured === null) {
            throw new NotFoundError('plugin-not-found', `plugin '${plan.resourceId}' not found`)
          }
          if (
            dependencies.pluginOperationConfigHashOf(captured) !== plan.expectedRevision.configHash
          ) {
            throw staleConflictError('plugin', 'the plugin changed; reload before saving')
          }
          remember({
            plan,
            kind: 'plugin-update',
            spec: payload.spec,
            specChanged: payload.spec !== captured.spec,
            captured,
            payload: {
              options: payload.optionsJson ?? {},
              description: payload.description ?? captured.description,
              enabled: payload.enabled ?? captured.enabled,
            },
          })
          return
        }
        case 'skill':
          remember({ plan, kind: plan.action === 'create' ? 'skill-create' : 'skill-update' } as
            | Extract<PreparedMutation, { readonly kind: 'skill-create' }>
            | Extract<PreparedMutation, { readonly kind: 'skill-update' }>)
          return
        case 'workflow': {
          const definition = migrateWorkflowDefinitionToLatest(
            WorkflowDefinitionSchema.parse(plan.payload.definition),
          )
          if (plan.action === 'create') {
            remember({ plan, kind: 'workflow-create', definition })
            return
          }
          remember({
            plan,
            kind: 'workflow-update',
            prepared: await dependencies.prepareWorkflowSave(
              db,
              plan.resourceId,
              {
                expectedVersion: plan.expectedRevision.version,
                clientMutationId: context.clientMutationId,
                snapshot: {
                  name: plan.payload.name,
                  description: plan.payload.description,
                  definition,
                },
              },
              { kind: 'actor', actor },
            ),
          })
          return
        }
        case 'workgroup': {
          if (plan.action === 'create') {
            const parsed = CreateWorkgroupSchema.parse(plan.payload)
            const prepared = await dependencies.prepareWorkgroupCreate(db, parsed, {
              ownerUserId: actor.user.id,
              actor,
              pendingAgentNames: context.pendingAgentNames,
            })
            remember({
              plan,
              kind: 'workgroup-create',
              prepared: {
                ...(prepared as Readonly<Record<string, unknown>>),
                groupId: plan.resourceId,
              },
            })
            return
          }
          remember({
            plan,
            kind: 'workgroup-update',
            prepared: await dependencies.prepareWorkgroupSave(
              db,
              plan.resourceId,
              {
                expectedVersion: plan.expectedRevision.version,
                clientMutationId: context.clientMutationId,
                snapshot: WorkgroupDraftSnapshotSchema.parse(plan.payload),
              },
              { kind: 'actor', actor },
            ),
          })
        }
      }
    },
    async prestage(plan, context) {
      const prepared = requirePrepared(plan)
      if (
        prepared.kind === 'plugin-create' ||
        (prepared.kind === 'plugin-update' && prepared.specChanged)
      ) {
        const generationId = ulid()
        const generationDir = dependencies.plannedGenerationDir(
          plan.resourceId,
          prepared.spec,
          generationId,
          options.pluginInstallOpts?.pluginsDir,
        )
        if (generationDir !== null) {
          context.recordArtifact({
            kind: 'plugin-install',
            pluginId: plan.resourceId,
            generationId,
            generationDir,
          })
        }
        const install = await dependencies.installPlugin(plan.resourceId, prepared.spec, {
          ...options.pluginInstallOpts,
          generationId,
        })
        pluginInstalls.set(plan.operationId, install)
        options.afterPluginInstall?.()
        return
      }
      if (prepared.kind === 'skill-update') {
        const payload = skillPayload(prepared.plan)
        const staged = dependencies.stageSkillVersion(
          db,
          { appHome },
          plan.resourceId,
          (stagingDir) => writeSkillTree(stagingDir, payload),
          {
            source: 'editor',
            authorUserId: actor.user.id,
            expectedOwnerUserId: actor.user.id,
            setDescription: payload.description,
          },
        )
        skillVersionStages.set(plan.operationId, staged)
        context.recordArtifact({ kind: 'skill-version-stage', staged })
        options.afterSkillStage?.()
        return
      }
      if (prepared.kind === 'skill-create') {
        const payload = skillPayload(prepared.plan)
        const stage = await dependencies.stageManagedSkill(
          db,
          { appHome },
          {
            name: payload.name,
            description: payload.description,
            ownerUserId: actor.user.id,
            actor,
            id: plan.resourceId,
          },
          (filesDir) => writeSkillTree(filesDir, payload),
        )
        skillStages.set(plan.operationId, stage)
        context.recordArtifact({ kind: 'skill-stage', ...stage })
        options.afterSkillStage?.()
      }
    },
    participantInTransaction(tx, context) {
      return createIntentApplyResourceParticipantInTx({
        agent: (authority, plan) => commit(tx, context, authority, plan),
        skill: (authority, plan) => commit(tx, context, authority, plan),
        mcp: (authority, plan) => commit(tx, context, authority, plan),
        plugin: (authority, plan) => commit(tx, context, authority, plan),
        workflow: (authority, plan) => commit(tx, context, authority, plan),
        workgroup: (authority, plan) => commit(tx, context, authority, plan),
      })
    },
    broadcastCommitted() {
      for (const row of createdWorkflowRows) {
        try {
          dependencies.broadcastWorkflowCreated(row)
        } catch {
          /* broadcast is fire-and-forget */
        }
      }
      for (const row of createdWorkgroups) {
        try {
          dependencies.broadcastWorkgroupCreated(row)
        } catch {
          /* broadcast is fire-and-forget */
        }
      }
    },
  }
  return Object.freeze(session)
}
