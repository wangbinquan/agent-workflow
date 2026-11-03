// RFC-401 T6（proposal G5）—— agent / workflow / workgroup 的写入夹具，只经生产写入入口落库。
//
// 由来：`legacy/agent.ts` 的 createAgent / updateAgent / renameAgent、`legacy/workflow.ts` 的 createWorkflow / updateWorkflow /
// copyWorkflow、`legacy/workgroups.ts` 的 createWorkgroup / saveWorkgroup / copyWorkgroup / renameWorkgroup 零生产调用，却各自
// 重放一遍写入程序（AC-1 结构锁把它们记作只能缩小的旧导入方）。G5 删除它们，用例改经本文件写入。这里只调用生产入口：
//   - 带执行者的编辑、改名、复制走资源目录的操作（与路由同一条：解析、可见、编辑 / 治理权、内建只读、WS 广播）；
//   - 新建走唯一写入参与者或仓库（夹具常要指定 id 或内建行），没给执行者时以 admin 夹具身份写入；
//   - 没给执行者的编辑沿用旧的「系统」语义，不做可见性与编辑权判定：agent 经参与者；workflow / workgroup 以 admin 身份
//     走目录操作（内建 workflow 照旧只读，提交后照旧广播）。
// 旧函数允许 owner 为空的行，参与者要求 owner，没给时记为 `FIXTURE_OWNER`。旧 createAgent 接受按名字的引用，这里先按 id、
// 再按名字解析成规范 id（夹具便利；生产入口只收规范 id）。

import type {
  Agent,
  CopyWorkflowRequest,
  CopyWorkgroupRequest,
  CreateAgent,
  CreateWorkflow,
  CreateWorkgroup,
  RenameAgent,
  SaveWorkflowReceipt,
  SaveWorkgroupReceipt,
  UpdateAgent,
  UpdateWorkflow,
  UpdateWorkgroup,
  WorkflowDetail,
  WorkgroupDetail,
} from '@agent-workflow/shared'
import { CreateAgentSchema, CreateWorkflowSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import { AuthorityClaimRegistry } from '@/modules/identity-access/application/operationContext'
import { composeDatabaseAgentCatalog } from '@/modules/resource-catalog/composition/agentOperations'
import { composeAgentImportQueries } from '@/modules/resource-catalog/composition/agentImportQueries'
import {
  composeAgentResourceIntegrity,
  composeDatabaseAgentResourceInventorySource,
} from '@/modules/resource-catalog/composition/agentResourceIntegrity'
import { composeResourceCatalogFor } from '@/modules/resource-catalog/composition/providerResourceCatalog'
import { composeWorkgroupCatalog } from '@/modules/resource-catalog/composition/workgroupOperations'
import { workflowBroadcastEvents } from '@/modules/resource-catalog/composition/workflowOperations'
import type { AgentRuntimeProfileLookup } from '@/modules/resource-catalog/infrastructure/agentBranchPorts'
import { createAgentMutationParticipant } from '@/modules/resource-catalog/infrastructure/agentMutationParticipant'
import { createAgentPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/agentPersistenceSemantics'
import { createAgentRepository } from '@/modules/resource-catalog/infrastructure/agentRepository'
import { getAgentById } from '@/modules/resource-catalog/infrastructure/legacy/agent'
import { getWorkflow } from '@/modules/resource-catalog/infrastructure/legacy/workflow'
import { getWorkgroupById } from '@/modules/resource-catalog/infrastructure/legacy/workgroups'
import { runResourceCatalogTransaction } from '@/modules/resource-catalog/infrastructure/resourceCatalogTransaction'
import { createWorkflowMutationParticipant } from '@/modules/resource-catalog/infrastructure/workflowMutationParticipant'
import { createWorkflowPersistenceSemantics } from '@/modules/resource-catalog/infrastructure/workflowPersistenceSemantics'
import { createWorkflowRepository } from '@/modules/resource-catalog/infrastructure/workflowRepository'

import { workgroupDraftSnapshotOf } from '@/modules/resource-catalog/infrastructure/workgroupPersistence'
import { composeSubjectTaskReferencePort } from '@/modules/task-execution/composition'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { NotFoundError, ValidationError } from '@/util/errors'
import { workflowCatalogFor } from '../workflowCatalog'

/** 旧函数里 owner 为空的行在这里的 owner。 */
export const FIXTURE_OWNER = 'fixture-owner'

export type ResourceWritePrincipal =
  | { readonly kind: 'actor'; readonly actor: Actor }
  | { readonly kind: 'system'; readonly reason: string }

interface ResourceFence {
  readonly expectedUpdatedAt: number
  readonly expectedAclRevision: number
}

function adminActor(userId: string): Actor {
  return buildActor({
    user: {
      id: userId,
      username: `u-${userId}`,
      displayName: userId,
      role: 'admin',
      status: 'active',
    },
    source: 'session',
  })
}

function authorityOf(actor: Actor) {
  return new AuthorityClaimRegistry().mintDirectAuthority(
    { userId: actor.user.id, source: actor.source },
    { ...actor, userId: actor.user.id },
  ).actor
}

function jsonBody(value: unknown) {
  return { kind: 'json-body' as const, body: JSON.stringify(value) }
}

function runtimeProfiles(db: PersistenceDb): AgentRuntimeProfileLookup {
  return Object.freeze({
    async get(name: string) {
      const { runtimes } = tablesOf(db)
      const [row] = await db
        .select({ enabled: runtimes.enabled })
        .from(runtimes)
        .where(eq(runtimes.name, name))
        .limit(1)
      return row === undefined ? null : Object.freeze({ enabled: row.enabled })
    },
  })
}

function agentCatalogFor(db: PersistenceDb) {
  const resourceCatalog = composeResourceCatalogFor({ db })
  return composeDatabaseAgentCatalog({
    taskReferences: composeSubjectTaskReferencePort,
    db,
    resourceCatalog,
    runtimeProfiles: runtimeProfiles(db),
    importQueries: composeAgentImportQueries(db),
    resourceIntegrityQueries: composeAgentResourceIntegrity(
      composeDatabaseAgentResourceInventorySource({
        db,
        authorization: resourceCatalog.authorization,
      }),
    ).queries,
  })
}

function agentRepositoryFor(db: PersistenceDb) {
  const resourceCatalog = composeResourceCatalogFor({ db })
  return createAgentRepository({
    db,
    semantics: createAgentPersistenceSemantics({
      taskReferences: composeSubjectTaskReferencePort,
      db,
      authorization: resourceCatalog.authorization,
    }),
    runtimes: runtimeProfiles(db),
  })
}

function workflowRepositoryFor(db: PersistenceDb, id?: string) {
  const resourceCatalog = composeResourceCatalogFor({ db })
  return createWorkflowRepository({
    db,
    semantics: createWorkflowPersistenceSemantics({
      taskReferences: composeSubjectTaskReferencePort,
      authorization: resourceCatalog.authorization,
      events: workflowBroadcastEvents(),
    }),
    ...(id === undefined ? {} : { id: () => id }),
  })
}

function workgroupCatalogFor(db: PersistenceDb) {
  return composeWorkgroupCatalog({
    db,
    resourceCatalog: composeResourceCatalogFor({ db }),
    taskReferences: composeSubjectTaskReferencePort,
  })
}

/** 引用按 id、再按名字解析成规范 id；都找不到的原样交给参与者报错。 */
async function canonicalId(
  db: PersistenceDb,
  table: 'agents' | 'mcps' | 'plugins' | 'skills',
  value: string,
): Promise<string> {
  const rows = tablesOf(db)[table]
  const [byId] = await db.select({ id: rows.id }).from(rows).where(eq(rows.id, value)).limit(1)
  if (byId !== undefined) return value
  const [byName] = await db.select({ id: rows.id }).from(rows).where(eq(rows.name, value)).limit(1)
  return byName?.id ?? value
}

interface AgentReferenceFields {
  readonly dependsOn?: readonly string[]
  readonly mcp?: readonly string[]
  readonly plugins?: readonly string[]
  readonly skills?: CreateAgent['skills']
}

async function canonicalReferences<T extends AgentReferenceFields>(
  db: PersistenceDb,
  agent: T,
): Promise<T> {
  const ids = async (
    table: 'agents' | 'mcps' | 'plugins',
    values: readonly string[] | undefined,
  ) =>
    values === undefined
      ? undefined
      : await Promise.all(values.map((value) => canonicalId(db, table, value)))
  const dependsOn = await ids('agents', agent.dependsOn)
  const mcp = await ids('mcps', agent.mcp)
  const plugins = await ids('plugins', agent.plugins)
  const skills =
    agent.skills === undefined
      ? undefined
      : await Promise.all(
          agent.skills.map(async (ref) =>
            ref.kind === 'managed'
              ? { ...ref, skillId: await canonicalId(db, 'skills', ref.skillId) }
              : ref,
          ),
        )
  return {
    ...agent,
    ...(dependsOn === undefined ? {} : { dependsOn }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(plugins === undefined ? {} : { plugins }),
    ...(skills === undefined ? {} : { skills }),
  } as T
}

// ── agent ──────────────────────────────────────────────────────────────────

export async function createAgent(
  db: PersistenceDb,
  input: CreateAgent,
  opts: {
    readonly ownerUserId?: string
    readonly builtin?: boolean
    readonly actor?: Actor | null
    readonly id?: string
    readonly beforeWriteTransaction?: () => void | Promise<void>
  } = {},
): Promise<Agent> {
  const parsed = CreateAgentSchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError('agent-invalid', 'invalid agent payload', {
      issues: parsed.error.issues,
    })
  const ownerUserId = opts.ownerUserId ?? opts.actor?.user.id ?? FIXTURE_OWNER
  const agent = await canonicalReferences(db, parsed.data)
  const id = opts.id ?? ulid()
  await opts.beforeWriteTransaction?.()
  return await runResourceCatalogTransaction(db, (transaction) =>
    createAgentMutationParticipant(transaction, { runtimes: runtimeProfiles(db) }).create(
      opts.builtin === true
        ? { kind: 'system', userId: ownerUserId }
        : { kind: 'actor', actor: opts.actor ?? adminActor(ownerUserId) },
      { id, agent },
    ),
  )
}

async function currentAgent(db: PersistenceDb, id: string): Promise<Agent> {
  const current = await getAgentById(db, id)
  if (current === null) throw new NotFoundError('agent-not-found', 'agent not found')
  return current
}

function agentFence(current: Agent, fence: ResourceFence | undefined): ResourceFence {
  return (
    fence ?? {
      expectedUpdatedAt: current.updatedAt,
      expectedAclRevision: current.aclRevision ?? 0,
    }
  )
}

export async function updateAgent(
  db: PersistenceDb,
  id: string,
  patch: UpdateAgent,
  actor?: Actor | null,
  fence?: ResourceFence,
  hooks?: { readonly beforeWriteTransaction?: () => void | Promise<void> },
): Promise<Agent> {
  const current = await currentAgent(db, id)
  const canonical = await canonicalReferences(db, patch)
  const expected = agentFence(current, fence)
  await hooks?.beforeWriteTransaction?.()
  if (actor !== undefined && actor !== null) {
    await agentCatalogFor(db).operations.update.invoke(authorityOf(actor), {
      id,
      submission: jsonBody({ ...canonical, ...expected }),
    })
  } else {
    await runResourceCatalogTransaction(db, (transaction) =>
      createAgentMutationParticipant(transaction, { runtimes: runtimeProfiles(db) }).update(
        { kind: 'system', userId: current.ownerUserId ?? FIXTURE_OWNER },
        { id, fence: expected, patch: () => canonical },
      ),
    )
  }
  return await currentAgent(db, id)
}

export async function renameAgent(
  db: PersistenceDb,
  id: string,
  input: RenameAgent,
  opts?: {
    readonly actor: Actor
    readonly expectedUpdatedAt: number
    readonly expectedAclRevision: number
  },
): Promise<Agent> {
  if (opts !== undefined) {
    await agentCatalogFor(db).operations.rename.invoke(authorityOf(opts.actor), {
      id,
      rename: {
        ...input,
        expectedUpdatedAt: opts.expectedUpdatedAt,
        expectedAclRevision: opts.expectedAclRevision,
      },
    })
  } else {
    const current = await currentAgent(db, id)
    await agentRepositoryFor(db).rename(
      authorityOf(adminActor(current.ownerUserId ?? FIXTURE_OWNER)),
      id,
      input,
      agentFence(current, undefined),
    )
  }
  return await currentAgent(db, id)
}

// ── workflow ───────────────────────────────────────────────────────────────

export async function createWorkflow(
  db: PersistenceDb,
  input: CreateWorkflow,
  opts: {
    readonly ownerUserId?: string
    readonly builtin?: boolean
    readonly id?: string
    readonly actor?: Actor | null
    readonly beforeWriteTransaction?: () => void | Promise<void>
  } = {},
): Promise<WorkflowDetail> {
  const parsed = CreateWorkflowSchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError('workflow-invalid', 'invalid workflow payload', {
      issues: parsed.error.issues,
    })
  const ownerUserId = opts.ownerUserId ?? opts.actor?.user.id ?? FIXTURE_OWNER
  const id = opts.id ?? ulid()
  await opts.beforeWriteTransaction?.()
  if (opts.builtin === true) {
    await runResourceCatalogTransaction(db, (transaction) =>
      createWorkflowMutationParticipant(transaction).create(
        { kind: 'system', userId: ownerUserId, reason: 'test-fixture' },
        { id, content: parsed.data },
      ),
    )
  } else {
    await workflowRepositoryFor(db, id).create(
      authorityOf(opts.actor ?? adminActor(ownerUserId)),
      parsed.data,
    )
  }
  const created = await getWorkflow(db, id)
  if (created === null) throw new Error('workflow disappeared right after insert')
  return created
}

export async function updateWorkflow(
  db: PersistenceDb,
  id: string,
  input: UpdateWorkflow,
  principal: ResourceWritePrincipal,
  opts?: { readonly beforeWriteTransaction?: () => void | Promise<void> },
): Promise<SaveWorkflowReceipt> {
  await opts?.beforeWriteTransaction?.()
  // 旧「系统」写入者不做可见性与编辑权判定，但内建 workflow 照样只读：admin 身份走同一条操作即是这一语义。
  const actor =
    principal.kind === 'actor'
      ? principal.actor
      : adminActor((await getWorkflow(db, id))?.ownerUserId ?? FIXTURE_OWNER)
  return await workflowCatalogFor(db).operations.update.invoke(authorityOf(actor), {
    id,
    submission: jsonBody(input),
  })
}

export async function copyWorkflow(
  db: PersistenceDb,
  sourceId: string,
  input: CopyWorkflowRequest,
  actor: Actor,
): Promise<WorkflowDetail> {
  return await workflowCatalogFor(db).operations.copy.invoke(authorityOf(actor), {
    id: sourceId,
    copy: input,
  })
}

// ── workgroup ──────────────────────────────────────────────────────────────

export async function createWorkgroup(
  db: PersistenceDb,
  input: CreateWorkgroup,
  opts: {
    readonly ownerUserId?: string
    readonly actor?: Actor | null
    readonly beforeWriteTransaction?: () => void | Promise<void>
  } = {},
): Promise<WorkgroupDetail> {
  const ownerUserId = opts.ownerUserId ?? opts.actor?.user.id ?? FIXTURE_OWNER
  await opts.beforeWriteTransaction?.()
  return await workgroupCatalogFor(db).operations.create.invoke(
    authorityOf(opts.actor ?? adminActor(ownerUserId)),
    input,
  )
}

export async function saveWorkgroup(
  db: PersistenceDb,
  id: string,
  input: UpdateWorkgroup,
  principal: ResourceWritePrincipal,
  opts?: { readonly beforeWriteTransaction?: () => void | Promise<void> },
): Promise<SaveWorkgroupReceipt> {
  await opts?.beforeWriteTransaction?.()
  // 旧「系统」写入者不做可见性与编辑权判定；admin 身份走同一条操作（含提交后的 WS 广播）。
  const actor =
    principal.kind === 'actor'
      ? principal.actor
      : adminActor((await getWorkgroupById(db, id))?.ownerUserId ?? FIXTURE_OWNER)
  return await workgroupCatalogFor(db).operations.update.invoke(authorityOf(actor), {
    id,
    update: input,
  })
}

export async function copyWorkgroup(
  db: PersistenceDb,
  sourceId: string,
  input: CopyWorkgroupRequest,
  actor: Actor,
): Promise<WorkgroupDetail> {
  return await workgroupCatalogFor(db).operations.copy.invoke(authorityOf(actor), {
    id: sourceId,
    copy: input,
  })
}

/** 改名就是一次只改名称（与描述）的保存（同旧 `renameWorkgroup`）。 */
export async function renameWorkgroup(
  db: PersistenceDb,
  id: string,
  input: {
    readonly newName: string
    readonly description?: string
    readonly expectedVersion: number
    readonly clientMutationId: string
  },
  principal: ResourceWritePrincipal,
): Promise<SaveWorkgroupReceipt> {
  const current = await getWorkgroupById(db, id)
  if (current === null)
    throw new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
  const snapshot = workgroupDraftSnapshotOf(current)
  return await saveWorkgroup(
    db,
    id,
    {
      expectedVersion: input.expectedVersion,
      clientMutationId: input.clientMutationId,
      snapshot: {
        ...snapshot,
        name: input.newName,
        description: input.description ?? snapshot.description,
      },
    },
    principal,
  )
}

/** 旧 `legacy/workflow.ts` / `legacy/workgroups.ts` 的写入者类型名。 */
export type WorkflowWritePrincipal = ResourceWritePrincipal
export type WorkgroupWritePrincipal = ResourceWritePrincipal
