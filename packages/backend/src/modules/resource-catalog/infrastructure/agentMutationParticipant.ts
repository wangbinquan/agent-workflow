// RFC-401 A1 —— agent 的唯一写入参与者（design §9.2）。
//
// 普通 CRUD、Intent、资源包与数字员工模板都经这里写 agent，全部 SQL 在调用方传入的事务上执行。校验次序与错误
// code / message / details 就是普通编辑此前的那一份（RFC-359 W4-D14 的 `agentPersistenceSemantics`，用户 2026-11-02
// 确认以它为准）：
//
//   branch port → runtime（不存在；改成停用的）→ 依赖 / MCP / plugin 新增引用的存在与可见 → plugin 全量启用
//   → 依赖图 → RFC-228 闭包 → managed skill 新增引用的可见 → 名称冲突 → 写入
//
// 此前 Intent 与资源包各有一份校验：Intent 合并存在与可见、报 `acl-missing-refs`，runtime 只查存在且报
// `agent-runtime-not-found`，不做 branch port、执行合同端口与闭包校验；资源包把不可见的 external 报成
// `package-external-unresolved`，环在排序时抛普通 Error（落成 `internal-error`）。

import {
  agentReferenceIds,
  type AclResourceType,
  type Agent,
  type AgentSkillRef,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import { monotonicNow } from '@/util/time'
import { assertAgentResourceIntegrity } from '../application/agents/agentResourceIntegrity'
import type {
  AgentMutationBatch,
  AgentMutationOwner,
  AgentMutationParticipant,
} from '../application/ports/agentMutation'
import type { AgentReferenceInsertInput } from '../application/ports/agentReferenceWrite'
import { assertAgentDependencyGraph } from '../domain/agentDependencies'
import {
  reconcileCreatedAgentExecutionContractPorts,
  reconcileUpdatedAgentExecutionContractPorts,
} from '../domain/agentExecutionContractPorts'
import { uniqueAgentReferences } from '../domain/agentReferenceKey'
import { isVisibleRow } from '../domain/resourceAccess'
import { PLUGIN_DISABLED_ERROR_CODE } from '../domain/disabledResourcePolicy'
import {
  assertAgentRuntime,
  assertBranchPortsDeclared,
  transactionRuntimeLookup,
  type AgentRuntimeProfileLookup,
} from './agentBranchPorts'
import { createAgentDependencyReadPort } from './agentDependencyRead'
import {
  agentFromPersistenceRow,
  createAgentPersistenceValues,
  loadAgentPersistenceRow,
} from './agentPersistence'
import { createAgentReferenceWriteParticipant } from './agentReferenceWrite'
import {
  bootVerifiedSkillAvailability,
  createTransactionAgentResourceInventoryReadPort,
  type AgentResourceSkillAvailability,
} from './agentResourceInventory'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'
import { grantedResourceIdsFor } from './resourceVisibility'

export type { AgentRuntimeProfileLookup } from './agentBranchPorts'

interface NamedAclRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

type ReferenceType = Extract<AclResourceType, 'agent' | 'skill' | 'mcp' | 'plugin'>

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

function managedSkillIds(refs: readonly AgentSkillRef[]): string[] {
  return unique(agentReferenceIds({ skills: refs }, 'skill'))
}

/** 只校验新增引用（CLAUDE.md §Resource ACL）：已在用的引用后来不可见或被删，由闭包校验报。 */
function onlyNew(next: readonly string[], previous: readonly string[] | undefined): string[] {
  const existing = new Set(previous ?? [])
  return unique(next).filter((id) => !existing.has(id))
}

async function rowsByIds(
  transaction: ResourceCatalogTransaction,
  type: ReferenceType,
  ids: readonly string[],
): Promise<readonly NamedAclRow[]> {
  if (ids.length === 0) return []
  const { agents, skills, mcps, plugins } = tablesOf(transaction)
  switch (type) {
    case 'agent':
      return transaction
        .select({
          id: agents.id,
          name: agents.name,
          ownerUserId: agents.ownerUserId,
          visibility: agents.visibility,
        })
        .from(agents)
        .where(inArray(agents.id, [...ids]))
    case 'skill':
      return transaction
        .select({
          id: skills.id,
          name: skills.name,
          ownerUserId: skills.ownerUserId,
          visibility: skills.visibility,
        })
        .from(skills)
        .where(and(inArray(skills.id, [...ids]), eq(skills.reservationState, 'ready')))
    case 'mcp':
      return transaction
        .select({
          id: mcps.id,
          name: mcps.name,
          ownerUserId: mcps.ownerUserId,
          visibility: mcps.visibility,
        })
        .from(mcps)
        .where(inArray(mcps.id, [...ids]))
    case 'plugin':
      return transaction
        .select({
          id: plugins.id,
          name: plugins.name,
          ownerUserId: plugins.ownerUserId,
          visibility: plugins.visibility,
        })
        .from(plugins)
        .where(and(inArray(plugins.id, [...ids]), eq(plugins.enabled, true)))
  }
}

/**
 * RFC-031 的 `plugin-disabled` 闸（RFC-359 §5fq 回补）：`enabled` 是被引用资源的状态，按全量引用查；
 * 存在性 / 可见性仍只查新增引用。
 */
async function assertPluginsEnabled(
  transaction: ResourceCatalogTransaction,
  ids: readonly string[],
): Promise<void> {
  const requested = unique(ids)
  if (requested.length === 0) return
  const { plugins } = tablesOf(transaction)
  const rows = await transaction
    .select({ id: plugins.id, enabled: plugins.enabled })
    .from(plugins)
    .where(inArray(plugins.id, requested))
  const disabled = rows.filter((row) => !row.enabled).map((row) => row.id)
  if (disabled.length > 0) {
    throw new ValidationError(
      PLUGIN_DISABLED_ERROR_CODE,
      `agent references disabled plugin(s): ${disabled.join(', ')}`,
      { disabled },
    )
  }
}

async function assertReferencesUsable(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly owner: AgentMutationOwner
  readonly type: ReferenceType
  readonly ids: readonly string[]
  readonly missingCode: string
  readonly missingLabel: string
  /** 本批的 agent：同一次提交里写入，属于写入者自己。 */
  readonly batch?: AgentMutationBatch
}): Promise<void> {
  const batch = input.batch
  const ids = unique(input.ids).filter(
    (id) =>
      input.type !== 'agent' || batch === undefined || batch.pendingDependencies(id) === undefined,
  )
  if (ids.length === 0) return
  const owner = input.owner
  const [rows, grants] = await Promise.all([
    rowsByIds(input.transaction, input.type, ids),
    owner.kind === 'actor'
      ? grantedResourceIdsFor(input.transaction, owner.actor, input.type)
      : Promise.resolve(new Set<string>()),
  ])
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    throw new ValidationError(
      input.missingCode,
      `agent references unknown ${input.missingLabel}(s): ${missing.join(', ')}`,
      { notFound: missing },
    )
  }
  // 系统内建写入（数字员工模板）不受引用方 ACL 约束。
  if (owner.kind !== 'actor') return
  const hidden = ids.filter((id) => {
    const row = byId.get(id)
    return row !== undefined && !isVisibleRow(owner.actor, row, grants)
  })
  if (hidden.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${hidden.map((id) => `${input.type} '${id}'`).join(', ')}`,
      { missing: hidden.map((id) => ({ type: input.type, name: id })) },
    )
  }
}

async function assertDependencyGraph(
  transaction: ResourceCatalogTransaction,
  candidateId: string,
  dependencyIds: readonly string[],
  batch: AgentMutationBatch | undefined,
): Promise<void> {
  const stored = createAgentDependencyReadPort(transaction, 'semantics')
  await assertAgentDependencyGraph({
    candidateId,
    dependencies: dependencyIds,
    roots: unique(dependencyIds),
    // 本批的 agent 以最终 dependsOn 参与遍历：批内的环与自依赖按同一判据报出。
    load: async (id) => batch?.pendingDependencies(id) ?? stored.load(id),
    semantics: 'catalog',
  })
}

/**
 * RFC-228 闭包预检：缺失或不可注入的 managed skill、停用的 plugin 等在这里以 `agent-resources-invalid` + issues 报出
 * （`rfc223-pr1-impl-gate` 锁定）。库存读调用方事务；本批新建的技能在提交后才发布，视为可用。
 */
async function assertResourceClosure(
  transaction: ResourceCatalogTransaction,
  candidate: Agent,
  batch: AgentMutationBatch | undefined,
): Promise<void> {
  const staged = batch?.stagedSkillIds
  const skillAvailability: AgentResourceSkillAvailability =
    staged === undefined || staged.size === 0
      ? bootVerifiedSkillAvailability
      : {
          isAvailable: (entry) =>
            staged.has(entry.skill.id) || bootVerifiedSkillAvailability.isAvailable(entry),
        }
  await assertAgentResourceIntegrity(
    createTransactionAgentResourceInventoryReadPort({ transaction, skillAvailability }),
    [candidate.id],
    { overrides: [candidate] },
  )
}

async function assertCandidate(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly owner: AgentMutationOwner
  readonly runtimes: AgentRuntimeProfileLookup
  readonly candidate: Agent
  readonly previous?: Agent
  readonly batch?: AgentMutationBatch
}): Promise<void> {
  const { transaction, owner, candidate, previous, batch } = input
  assertBranchPortsDeclared(candidate)
  await assertAgentRuntime(input.runtimes, candidate.runtime, previous?.runtime)
  await assertReferencesUsable({
    transaction,
    owner,
    type: 'agent',
    ids: onlyNew(candidate.dependsOn, previous?.dependsOn),
    missingCode: 'agent-dependency-not-found',
    missingLabel: 'agent dependency',
    ...(batch === undefined ? {} : { batch }),
  })
  await assertReferencesUsable({
    transaction,
    owner,
    type: 'mcp',
    ids: onlyNew(candidate.mcp, previous?.mcp),
    missingCode: 'mcp-not-found',
    missingLabel: 'mcp',
  })
  await assertReferencesUsable({
    transaction,
    owner,
    type: 'plugin',
    ids: onlyNew(candidate.plugins, previous?.plugins),
    missingCode: 'plugin-not-found',
    missingLabel: 'plugin',
  })
  await assertPluginsEnabled(transaction, candidate.plugins)
  await assertDependencyGraph(transaction, candidate.id, candidate.dependsOn, batch)
  await assertResourceClosure(transaction, candidate, batch)
  // managed skill 的可见性围栏放在闭包预检之后：缺失的 managed skill 由预检报，这里只兜授权与并发。
  await assertReferencesUsable({
    transaction,
    owner,
    type: 'skill',
    ids: onlyNew(managedSkillIds(candidate.skills), managedSkillIds(previous?.skills ?? [])),
    missingCode: 'skill-not-found',
    missingLabel: 'managed skill',
  })
}

function nameConflict(name: string): ConflictError {
  return new ConflictError('agent-name-in-use', `agent '${name}' already exists`)
}

function stale(id: string): ConflictError {
  return staleConflictError('agent', `agent '${id}' changed; reload and retry`)
}

/** owner + name 唯一冲突：PG 给约束名 `agents_owner_name_unique`，SQLite 给列清单 `agents.owner_user_id, …`。 */
function isOwnerNameConflict(transaction: ResourceCatalogTransaction, error: unknown): boolean {
  const target = engineOf(transaction).uniqueViolationTarget(error)
  return target !== undefined && /agents[._]owner/i.test(target)
}

function ownerRow(
  owner: AgentMutationOwner,
): Pick<AgentReferenceInsertInput, 'ownerUserId' | 'visibility' | 'builtin'> {
  return owner.kind === 'actor'
    ? { ownerUserId: owner.actor.user.id }
    : { ownerUserId: owner.userId, visibility: 'public', builtin: true }
}

export interface AgentMutationParticipantDependencies {
  /** runtime 查询；缺省读调用方事务里的 `runtimes` 表。普通 CRUD 注入 runtime registry 查询（同一张表）。 */
  readonly runtimes?: AgentRuntimeProfileLookup
  readonly now?: () => number
}

export type AgentMutationParticipantFactory = (
  transaction: ResourceCatalogTransaction,
) => AgentMutationParticipant

export function createAgentMutationParticipant(
  transaction: ResourceCatalogTransaction,
  dependencies: AgentMutationParticipantDependencies = {},
): AgentMutationParticipant {
  const runtimes = dependencies.runtimes ?? transactionRuntimeLookup(transaction)
  const now = dependencies.now ?? Date.now
  return Object.freeze<AgentMutationParticipant>({
    async create(owner, input) {
      const row = ownerRow(owner)
      const canonical = uniqueAgentReferences(
        reconcileCreatedAgentExecutionContractPorts(input.agent),
      )
      const values = createAgentPersistenceValues({
        id: input.id,
        agent: canonical,
        ownerUserId: row.ownerUserId,
        now: now(),
      })
      const candidate = agentFromPersistenceRow(values, canonical)
      await assertCandidate({
        transaction,
        owner,
        runtimes,
        candidate,
        ...(input.batch === undefined ? {} : { batch: input.batch }),
      })
      const { agents } = tablesOf(transaction)
      const collision = await first(
        transaction
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.ownerUserId, row.ownerUserId), eq(agents.name, candidate.name))),
      )
      if (collision !== undefined) throw nameConflict(candidate.name)
      let created: readonly Agent[]
      try {
        created = await createAgentReferenceWriteParticipant(transaction).insert({
          id: input.id,
          agent: canonical,
          now: values.createdAt,
          ...row,
        })
      } catch (error) {
        if (isOwnerNameConflict(transaction, error)) throw nameConflict(candidate.name)
        throw error
      }
      if (created.length !== 1) throw new Error('agent insert did not return one row')
      return created[0]!
    },

    async update(owner, input) {
      const { agents } = tablesOf(transaction)
      const row = await first(transaction.select().from(agents).where(eq(agents.id, input.id)))
      if (row === undefined) throw new NotFoundError('agent-not-found', 'agent not found')
      const current = await loadAgentPersistenceRow(transaction, row)
      input.guard?.(current)
      if (
        current.updatedAt !== input.fence.expectedUpdatedAt ||
        (current.aclRevision ?? 0) !== input.fence.expectedAclRevision
      ) {
        throw stale(input.id)
      }
      const patch = uniqueAgentReferences(
        reconcileUpdatedAgentExecutionContractPorts(current, await input.patch(current)),
      )
      const updatedAt = monotonicNow(current.updatedAt)
      const { runtime: _currentRuntime, ...currentWithoutRuntime } = current
      const { runtime: submittedRuntime, ...patchWithoutRuntime } = patch
      const runtime = submittedRuntime === null ? undefined : (submittedRuntime ?? current.runtime)
      const candidate: Agent = {
        ...currentWithoutRuntime,
        ...patchWithoutRuntime,
        ...(runtime === undefined ? {} : { runtime }),
        updatedAt,
      }
      await assertCandidate({
        transaction,
        owner,
        runtimes,
        candidate,
        previous: current,
        ...(input.batch === undefined ? {} : { batch: input.batch }),
      })
      const changed = await createAgentReferenceWriteParticipant(transaction).update({
        current,
        patch,
        updatedAt,
        expectedUpdatedAt: input.fence.expectedUpdatedAt,
        expectedAclRevision: input.fence.expectedAclRevision,
      })
      if (changed.length !== 1) throw stale(input.id)
      return changed[0]!
    },
  })
}

/**
 * 受信的内建种子写入（fusion 合并 agent、demo 样例）：内容由框架给出，不做校验，保持各自按稳定 id 幂等与漂移修复的
 * 语义；引用照样按 design §2.4 去重。agent 行只经本模块写入（RFC-401 结构锁）。
 */
export function insertSeedAgent(
  transaction: ResourceCatalogTransaction,
  input: AgentReferenceInsertInput,
): Promise<readonly Agent[]> {
  return createAgentReferenceWriteParticipant(transaction).insert({
    ...input,
    agent: uniqueAgentReferences(input.agent),
  })
}
