import { capturedSkillTreeColumns, skillRowPath } from '../databaseSkillTrees'
import {
  CreateAgentSchema,
  CreateMcpSchema,
  CreateWorkgroupSchema,
  UpdateAgentSchema,
  WG_CLARIFY_BUDGET_DEFAULT,
  WorkgroupDraftSnapshotSchema,
  WorkflowDefinitionSchema,
  migrateWorkflowDefinitionToLatest,
  resolveWorkgroupOutputContract,
  serializeWorkgroupEditableSnapshotV1,
  type Agent,
  type CreateAgent,
  type CreateMcp,
  type Mcp,
  type Skill,
  type WorkflowDefinition,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { createWorkflowMutationParticipant } from '../workflowMutationParticipant'
import { workflowCatalogPredicate } from '../workflowCatalogPredicate'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import type {
  IntentArtifactStage as StagedArtifactCapability,
  IntentPluginPublication as PostgresqlIntentPluginInstallResult,
  IntentPluginArtifactOwner as PostgresqlIntentPluginArtifactLifecycle,
  IntentSkillPublication as PostgresqlIntentSkillStageResult,
  IntentSkillArtifactOwner as PostgresqlIntentSkillArtifactLifecycle,
} from '../../application/intent/artifactOwners'
export type {
  IntentPluginPublication as PostgresqlIntentPluginInstallResult,
  IntentPluginArtifactOwner as PostgresqlIntentPluginArtifactLifecycle,
  IntentSkillPublication as PostgresqlIntentSkillStageResult,
  IntentSkillArtifactOwner as PostgresqlIntentSkillArtifactLifecycle,
} from '../../application/intent/artifactOwners'
import { withAgentSidecarsFrom } from '../../domain/agentSidecarBackfill'

import { and, eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DirectAuthenticatedAuthority } from '@/modules/identity-access/public/participants'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
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
import type { VersionedIntentResourceChangesetPlan } from '../../public/types'
import { loadAgentPersistenceRow } from '../agentPersistence'
import { mcpConfigHash } from '../mcpPersistence'
import { pluginConfigHash } from '../pluginPersistence'
import type { McpTransactionLifecycle } from '../mcpRepository'
import type { PostgresqlResourceCatalogTransaction } from '../postgresql/repositorySupport'
import {
  workgroupDraftMemberOf,
  workgroupMemberPersistenceValues,
  workgroupSnapshotValues,
} from '../workgroupPersistence'
import { workgroupFromRows } from '../workgroupRepository'
import type {
  IntentApplyMutationPort,
  IntentApplyPrepareContext,
  IntentApplyResourcePorts,
  IntentApplyResourceSessionOptions,
  IntentResourceChangesetReceipt,
} from './intentApplyResourceParticipants'
import type { AgentMutationBatch } from '../../application/ports/agentMutation'
import { createAgentMutationParticipant } from '../agentMutationParticipant'
import { createMcpMutationParticipant } from '../mcpMutationParticipant'
import { createPluginMutationParticipant } from '../pluginMutationParticipant'

type PlanOf<K extends CatalogSelectorKind> = Extract<
  VersionedIntentResourceChangesetPlan,
  { readonly kind: K }
>
type UpdatePlanOf<K extends CatalogSelectorKind> = Extract<PlanOf<K>, { readonly action: 'update' }>
type ReceiptOf<K extends CatalogSelectorKind> = Extract<
  IntentResourceChangesetReceipt,
  { readonly kind: K }
>

export interface PostgresqlIntentResourceCommitEvent {
  readonly kind: 'workflow' | 'workgroup'
  readonly action: 'create' | 'update'
  readonly resourceId: string
  readonly revision: number
}

export interface IntentApplyResourcePortFactoryDependencies {
  readonly db: PersistenceDb
  readonly mcpLifecycle: McpTransactionLifecycle
  readonly pluginArtifacts: PostgresqlIntentPluginArtifactLifecycle
  readonly skillContentKind?: 'local-file' | 'database-bytes'
  readonly skillArtifacts: PostgresqlIntentSkillArtifactLifecycle
  readonly id?: () => string
  readonly now?: () => number
  readonly committed?: (event: PostgresqlIntentResourceCommitEvent) => Promise<void> | void
}

type PreparedAgent =
  | Readonly<{
      kind: 'create'
      input: CreateAgent
      batch: AgentMutationBatch
    }>
  | Readonly<{
      kind: 'update'
      patch: Readonly<Record<string, unknown>>
      batch: AgentMutationBatch
    }>

type PreparedMcp = Readonly<{ input: CreateMcp }>

interface PreparedPlugin {
  readonly install: StagedArtifactCapability<PostgresqlIntentPluginInstallResult> | null
  staged: PostgresqlIntentPluginInstallResult | null
}

interface PreparedSkill {
  readonly stage: StagedArtifactCapability<PostgresqlIntentSkillStageResult>
  staged:
    | (PostgresqlIntentSkillStageResult & {
        readonly contentKind?: 'local-file' | 'database-bytes'
      })
    | null
}

type PreparedWorkflow = Readonly<{ definition: WorkflowDefinition }>
type PreparedWorkgroup = Readonly<{ snapshot: WorkgroupDraftSnapshot }>

function exactActor(options: IntentApplyResourceSessionOptions): DirectAuthenticatedAuthority {
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
  const { resourceGrants } = tablesOf(transaction)
  const grant = await first(
    transaction
      .select({ resourceId: resourceGrants.resourceId })
      .from(resourceGrants)
      .where(
        and(
          eq(resourceGrants.resourceType, type),
          eq(resourceGrants.resourceId, resourceId),
          eq(resourceGrants.userId, actor.user.id),
        ),
      ),
  )
  return grant !== undefined
}

async function visibleIdentity(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  type: CatalogSelectorKind,
  id: string,
): Promise<boolean> {
  const row = await (async () => {
    const { agents, skills } = tablesOf(transaction)
    const { mcps, plugins, workflows, workgroups } = tablesOf(transaction)
    switch (type) {
      case 'agent':
        return first(
          transaction
            .select({
              id: agents.id,
              ownerUserId: agents.ownerUserId,
              visibility: agents.visibility,
            })
            .from(agents)
            .where(eq(agents.id, id)),
        )
      case 'skill':
        return first(
          transaction
            .select({
              id: skills.id,
              ownerUserId: skills.ownerUserId,
              visibility: skills.visibility,
            })
            .from(skills)
            .where(eq(skills.id, id)),
        )
      case 'mcp':
        return first(
          transaction
            .select({ id: mcps.id, ownerUserId: mcps.ownerUserId, visibility: mcps.visibility })
            .from(mcps)
            .where(eq(mcps.id, id)),
        )
      case 'plugin':
        return first(
          transaction
            .select({
              id: plugins.id,
              ownerUserId: plugins.ownerUserId,
              visibility: plugins.visibility,
            })
            .from(plugins)
            .where(eq(plugins.id, id)),
        )
      case 'workflow':
        return first(
          transaction
            .select({
              id: workflows.id,
              ownerUserId: workflows.ownerUserId,
              visibility: workflows.visibility,
            })
            .from(workflows)
            .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, id))),
        )
      case 'workgroup':
        return first(
          transaction
            .select({
              id: workgroups.id,
              ownerUserId: workgroups.ownerUserId,
              visibility: workgroups.visibility,
            })
            .from(workgroups)
            .where(eq(workgroups.id, id)),
        )
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

function exactAgentPatch(plan: UpdatePlanOf<'agent'>): Readonly<Record<string, unknown>> {
  const { name: _name, ...patch } = plan.payload
  return patch
}

function applyAgentPatch(current: Agent, patch: Readonly<Record<string, unknown>>) {
  // RFC-358 T9：判据搬进 domain，与 create/copy 分支、以及另一个 provider 共用一份。
  return UpdateAgentSchema.parse(withAgentSidecarsFrom(patch, current))
}

/** RFC-401 A1：批内事实交给唯一的 agent 写入参与者（design §9.2）。 */
function agentBatchOf(context: IntentApplyPrepareContext): AgentMutationBatch {
  return Object.freeze({
    pendingDependencies: (id: string) => context.agentDependencies.get(id),
    // 本批新建的资源 id；只有其中的 managed skill 会被闭包校验命中（ULID 跨类型唯一）。
    stagedSkillIds: context.pendingIds,
  })
}

function createAgentPort(
  options: IntentApplyResourceSessionOptions,
  now: () => number,
): IntentApplyMutationPort<'agent', PreparedAgent> {
  const actor = exactActor(options)
  const owner = Object.freeze({ kind: 'actor' as const, actor })
  return Object.freeze({
    async prepare(plan, context) {
      if (plan.action === 'create') {
        return Object.freeze({
          kind: 'create',
          input: CreateAgentSchema.parse(plan.payload),
          batch: agentBatchOf(context),
        })
      }
      return Object.freeze({
        kind: 'update',
        patch: exactAgentPatch(plan),
        batch: agentBatchOf(context),
      })
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      const agents = createAgentMutationParticipant(transaction, { now })
      if (prepared.kind === 'create') {
        // RFC-358 T9（B-5）—— copy 把 update 归一成 create，而此前 create 分支不回填
        // sidecar，于是「复制一个 builtin agent 再改」会静默丢掉分支端口 / 输出 kind /
        // 角色 / fanout 重命名。源行只有在事务里才读得到，所以回填落在这里而不是
        // prepare（那时还没有 transaction）。判据本身在 domain，两个 provider 共用。
        let input = prepared.input
        const copiedFrom = plan.action === 'create' ? plan.copiedFromResourceId : undefined
        if (copiedFrom !== undefined) {
          const { agents: agentRows } = tablesOf(transaction)
          const sourceRow = await first(
            transaction.select().from(agentRows).where(eq(agentRows.id, copiedFrom)),
          )
          if (sourceRow !== undefined) {
            input = CreateAgentSchema.parse(
              withAgentSidecarsFrom(
                plan.payload,
                await loadAgentPersistenceRow(transaction, sourceRow),
              ),
            )
          }
        }
        const created = await agents.create(owner, {
          id: plan.resourceId,
          agent: input,
          batch: prepared.batch,
        })
        return agentReceipt(plan, {
          kind: 'agent',
          updatedAt: created.updatedAt,
          aclRevision: created.aclRevision ?? 0,
        })
      }
      if (plan.action !== 'update') {
        throw new Error('agent prepared action does not match changeset plan')
      }
      const updated = await agents.update(owner, {
        id: plan.resourceId,
        fence: {
          expectedUpdatedAt: plan.expectedRevision.updatedAt,
          expectedAclRevision: plan.expectedRevision.aclRevision,
        },
        // 场景规则：Intent 只允许 owner 原地修改、builtin 只读，原地改名只能走 copy 的 finalName 或改名流程。
        guard(current) {
          requireOwner(actor, 'agent', current)
          if (plan.payload.name !== current.name) {
            throw new ValidationError(
              'intent-rename-unsupported',
              'renaming via intent update is not supported; use the finalName slot on a copy, or the rename flow',
            )
          }
        },
        patch: (current) => applyAgentPatch(current, prepared.patch),
        batch: prepared.batch,
      })
      return agentReceipt(plan, {
        kind: 'agent',
        updatedAt: updated.updatedAt,
        aclRevision: updated.aclRevision ?? 0,
      })
    },
  } satisfies IntentApplyMutationPort<'agent', PreparedAgent>)
}

function mcpConfigWithPreservedOauth(submitted: CreateMcp, current: Mcp): CreateMcp['config'] {
  if (submitted.type !== 'remote' || current.type !== 'remote') return submitted.config
  if (submitted.config.oauth !== undefined || current.config.oauth === undefined) {
    return submitted.config
  }
  return Object.freeze({ ...submitted.config, oauth: current.config.oauth })
}

function createMcpPort(
  options: IntentApplyResourceSessionOptions,
  lifecycle: McpTransactionLifecycle,
  now: () => number,
): IntentApplyMutationPort<'mcp', PreparedMcp> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      return Object.freeze({ input: CreateMcpSchema.parse(plan.payload) })
    },
    async commitInTransaction({ transaction, plan, prepared }) {
      const mcps = createMcpMutationParticipant(transaction, { lifecycle, now })
      if (plan.action === 'create') {
        const created = await mcps.create({
          id: plan.resourceId,
          ownerUserId: actor.user.id,
          input: prepared.input,
        })
        return mcpReceipt(plan, { kind: 'mcp', configHash: mcpConfigHash(created) })
      }
      const updated = await mcps.update({
        id: plan.resourceId,
        expectedConfigHash: plan.expectedRevision.configHash,
        guard: (current) => requireOwner(actor, 'mcp', current),
        // 场景规则：模型改写时省略的 `oauth` 沿用库里的值（RFC-348 D2）；提交的配置整份替换库里的配置。
        patch: (current) => ({
          type: prepared.input.type,
          description: prepared.input.description,
          enabled: prepared.input.enabled,
          config: mcpConfigWithPreservedOauth(prepared.input, current),
        }),
      })
      return mcpReceipt(plan, { kind: 'mcp', configHash: mcpConfigHash(updated) })
    },
  } satisfies IntentApplyMutationPort<'mcp', PreparedMcp>)
}

function createPluginPort(
  options: IntentApplyResourceSessionOptions,
  db: PersistenceDb,
  artifacts: PostgresqlIntentPluginArtifactLifecycle,
  now: () => number,
): IntentApplyMutationPort<'plugin', PreparedPlugin> {
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
      const plugins = createPluginMutationParticipant(transaction, { now })
      if (plan.action === 'create') {
        if (prepared.staged === null) throw new Error('plugin install result missing')
        const created = await plugins.create({
          id: plan.resourceId,
          ownerUserId: actor.user.id,
          input: {
            name: plan.payload.name,
            spec: plan.payload.spec,
            options: plan.payload.optionsJson ?? {},
            description: plan.payload.description,
            enabled: plan.payload.enabled ?? true,
          },
          installation: prepared.staged,
        })
        return pluginReceipt(plan, { kind: 'plugin', configHash: pluginConfigHash(created) })
      }
      const updated = await plugins.update({
        id: plan.resourceId,
        expectedConfigHash: plan.expectedRevision.configHash,
        guard(current) {
          requireOwner(actor, 'plugin', current)
          if (plan.payload.name !== current.name) {
            throw new ValidationError(
              'intent-rename-unsupported',
              'renaming via intent update is not supported',
            )
          }
        },
        patch: () => ({
          spec: plan.payload.spec,
          options: plan.payload.optionsJson ?? {},
          ...(plan.payload.description === undefined
            ? {}
            : { description: plan.payload.description }),
          ...(plan.payload.enabled === undefined ? {} : { enabled: plan.payload.enabled }),
        }),
        // 规格不变时 prepare 不安装（`artifactsForPluginUpdate`），沿用当前安装。
        installation: prepared.staged,
      })
      return pluginReceipt(plan, { kind: 'plugin', configHash: pluginConfigHash(updated) })
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
  } satisfies IntentApplyMutationPort<'plugin', PreparedPlugin>)
}

async function artifactsForPluginUpdate(
  db: PersistenceDb,
  artifacts: PostgresqlIntentPluginArtifactLifecycle,
  plan: UpdatePlanOf<'plugin'>,
): Promise<StagedArtifactCapability<PostgresqlIntentPluginInstallResult> | null> {
  const { plugins } = tablesOf(db)
  const row = await first(
    db.select({ spec: plugins.spec }).from(plugins).where(eq(plugins.id, plan.resourceId)),
  )
  if (row === undefined) throw notFound('plugin', plan.resourceId)
  if (row.spec === plan.payload.spec) return null
  return artifacts.planInstall({
    pluginId: plan.resourceId,
    operationId: plan.operationId,
    spec: plan.payload.spec,
  })
}

function createSkillPort(
  options: IntentApplyResourceSessionOptions,
  db: PersistenceDb,
  artifacts: PostgresqlIntentSkillArtifactLifecycle,
  nextId: () => string,
  now: () => number,
  contentKind?: 'local-file' | 'database-bytes',
): IntentApplyMutationPort<'skill', PreparedSkill> {
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
      const { skills } = tablesOf(db)
      const row = await first(db.select().from(skills).where(eq(skills.id, plan.resourceId)))
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
        const { skills, skillVersions } = tablesOf(transaction)
        const collision = await first(
          transaction
            .select({ id: skills.id })
            .from(skills)
            .where(and(eq(skills.ownerUserId, actor.user.id), eq(skills.name, plan.payload.name))),
        )
        if (collision !== undefined) {
          throw new ConflictError(
            'skill-name-in-use',
            `skill '${plan.payload.name}' already exists`,
          )
        }
        await prepared.staged.commitInTransaction(transaction, 1)
        await insertOne(transaction, skills, {
          id: plan.resourceId,
          name: plan.payload.name,
          description: plan.payload.description,
          ...(await capturedSkillTreeColumns(
            contentKind ?? prepared.staged.contentKind ?? 'local-file',
            plan.resourceId,
            'live',
            prepared.staged.managedPath,
          )),
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
        await insertOne(transaction, skillVersions, {
          id: nextId(),
          skillId: plan.resourceId,
          versionIndex: 1,
          ...(await capturedSkillTreeColumns(
            contentKind ?? prepared.staged.contentKind ?? 'local-file',
            plan.resourceId,
            'version:1',
            prepared.staged.filesPath,
          )),
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

      const { skills, skillVersions } = tablesOf(transaction)
      const row = await first(
        transaction.select().from(skills).where(eq(skills.id, plan.resourceId)),
      )
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
      const changed = await first(
        transaction
          .update(skills)
          .set({
            description: plan.payload.description,
            contentVersion: versionIndex,
            ...(await capturedSkillTreeColumns(
              contentKind ?? prepared.staged.contentKind ?? 'local-file',
              current.id,
              'live',
              prepared.staged.managedPath,
            )),
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
          .returning({ id: skills.id }),
      )
      if (changed === undefined) throw staleConflictError('skill', `skill '${current.id}' changed`)
      await insertOne(transaction, skillVersions, {
        id: nextId(),
        skillId: current.id,
        versionIndex,
        ...(await capturedSkillTreeColumns(
          contentKind ?? prepared.staged.contentKind ?? 'local-file',
          current.id,
          `version:${versionIndex}`,
          prepared.staged.filesPath,
        )),
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
  } satisfies IntentApplyMutationPort<'skill', PreparedSkill>)
}

function skillFromRow(row: PersistenceTables['skills']['$inferSelect']): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceKind: 'managed',
    managedPath: skillRowPath(row, row.id, 'live') ?? undefined,
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

/**
 * RFC-401 A3：workflow 经唯一的写入参与者写入（design §9.4）。Intent 只保留自己的规则：owner-only 与禁止改名；
 * 批内新建的 workflow / workgroup 名称交给参与者视为可见。不再判重名，提交时也不做完整图校验（proposal §5 第 2、8 项）。
 */
function createWorkflowPort(
  options: IntentApplyResourceSessionOptions,
  committed: IntentApplyResourcePortFactoryDependencies['committed'],
  now: () => number,
): IntentApplyMutationPort<'workflow', PreparedWorkflow> {
  const actor = exactActor(options)
  return Object.freeze({
    async prepare(plan) {
      const definition = migrateWorkflowDefinitionToLatest(
        WorkflowDefinitionSchema.parse(plan.payload.definition),
      )
      return Object.freeze({ definition })
    },
    async commitInTransaction({ transaction, plan, prepared, context }) {
      const workflows = createWorkflowMutationParticipant(transaction, { now })
      const owner = { kind: 'actor', actor } as const
      const batch = Object.freeze({ createdNames: context.bundleCreatedNames })
      const content = {
        name: plan.payload.name,
        description: plan.payload.description,
        definition: prepared.definition,
      }
      if (plan.action === 'create') {
        const created = await workflows.create(owner, { id: plan.resourceId, content, batch })
        return workflowReceipt(plan, { kind: 'workflow', version: created.version })
      }
      const saved = await workflows.update(owner, {
        id: plan.resourceId,
        expectedVersion: plan.expectedRevision.version,
        patch: () => content,
        guard: (current, submittedName) => {
          requireOwner(actor, 'workflow', current)
          if (submittedName !== current.name) {
            throw new ValidationError(
              'intent-rename-unsupported',
              'renaming via intent update is not supported',
            )
          }
          return submittedName
        },
        batch,
      })
      return workflowReceipt(plan, { kind: 'workflow', version: saved.workflow.version })
    },
    afterCommitted: async ({ plan, receipt: result }) => {
      await committed?.({
        kind: 'workflow',
        action: plan.action,
        resourceId: plan.resourceId,
        revision: result.revision.version,
      })
    },
  } satisfies IntentApplyMutationPort<'workflow', PreparedWorkflow>)
}

function workgroupSnapshotFromRows(
  row: PersistenceTables['workgroups']['$inferSelect'],
  members: readonly PersistenceTables['workgroupMembers']['$inferSelect'][],
): WorkgroupDraftSnapshot {
  const group = workgroupFromRows(row, members)
  const ordered = [...group.members].sort((left, right) => left.sortOrder - right.sortOrder)
  const leader = ordered.find((member) => member.id === group.leaderMemberId)
  return WorkgroupDraftSnapshotSchema.parse(
    workgroupSnapshotValues(
      group,
      leader,
      () => ordered.map((member) => workgroupDraftMemberOf(member, '')),
      false,
      3,
    ),
  )
}

async function workgroupMemberValues(
  transaction: PostgresqlResourceCatalogTransaction,
  actor: DirectAuthenticatedAuthority,
  workgroupId: string,
  members: readonly WorkgroupDraftMember[],
  nextId: () => string,
  now: number,
): Promise<readonly PersistenceTables['workgroupMembers']['$inferInsert'][]> {
  const agentIds = members.flatMap((member) =>
    member.memberType === 'agent' && member.agentId !== undefined ? [member.agentId] : [],
  )
  await assertVisibleReferences(transaction, actor, [{ type: 'agent', ids: agentIds }])
  const { agents } = tablesOf(transaction)
  const { users } = tablesOf(transaction)
  const agentRows =
    agentIds.length === 0
      ? []
      : await transaction
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, agentIds))
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
  const active = new Set(activeUsers.map((row) => row.id))
  const inactive = userIds.filter((id) => !active.has(id))
  if (inactive.length > 0) {
    throw new ValidationError('workgroup-human-inactive', 'workgroup human members must be active')
  }
  return workgroupMemberPersistenceValues(workgroupId, members, now, names, nextId, 'defined')
}

function leaderMemberId(
  snapshot: WorkgroupDraftSnapshot,
  members: readonly PersistenceTables['workgroupMembers']['$inferInsert'][],
): string | null {
  if (snapshot.mode !== 'leader_worker' || snapshot.leaderDisplayName === undefined) return null
  return members.find((member) => member.displayName === snapshot.leaderDisplayName)?.id ?? null
}

function createWorkgroupPort(
  options: IntentApplyResourceSessionOptions,
  committed: IntentApplyResourcePortFactoryDependencies['committed'],
  nextId: () => string,
  now: () => number,
): IntentApplyMutationPort<'workgroup', PreparedWorkgroup> {
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
        const { workgroups, workgroupMembers } = tablesOf(transaction)
        const collision = await first(
          transaction
            .select({ id: workgroups.id })
            .from(workgroups)
            .where(
              and(
                eq(workgroups.ownerUserId, actor.user.id),
                eq(workgroups.name, prepared.snapshot.name),
              ),
            ),
        )
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
        const row = await first(
          transaction
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
            .returning({ version: workgroups.version }),
        )
        if (row === undefined) throw new Error('workgroup insert returned no row')
        for (const member of members) await insertOne(transaction, workgroupMembers, member)
        return workgroupReceipt(plan, { kind: 'workgroup', version: row.version })
      }

      const { workgroups, workgroupMembers } = tablesOf(transaction)
      const row = await first(
        transaction.select().from(workgroups).where(eq(workgroups.id, plan.resourceId)),
      )
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
      const changed = await first(
        transaction
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
          .returning({ version: workgroups.version }),
      )
      if (changed === undefined)
        throw staleConflictError('workgroup', `workgroup '${row.id}' changed`)
      await transaction.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, row.id))
      for (const member of replacement) await insertOne(transaction, workgroupMembers, member)
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
  } satisfies IntentApplyMutationPort<'workgroup', PreparedWorkgroup>)
}

/**
 * The concrete Resource Catalog owner factory. Callers inject only provider
 * lifecycles (MCP transition + filesystem artifacts); all six database arms
 * are fixed here and consume the transaction reserved by Intent.
 */
export function createIntentApplyResourcePortFactory(
  input: IntentApplyResourcePortFactoryDependencies,
): Readonly<{
  create(
    options: IntentApplyResourceSessionOptions,
  ): IntentApplyResourcePorts<
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
        skill: createSkillPort(
          options,
          input.db,
          input.skillArtifacts,
          nextId,
          now,
          input.skillContentKind,
        ),
        mcp: createMcpPort(options, input.mcpLifecycle, now),
        plugin: createPluginPort(options, input.db, input.pluginArtifacts, now),
        workflow: createWorkflowPort(options, input.committed, now),
        workgroup: createWorkgroupPort(options, input.committed, nextId, now),
      })
    },
  })
}
