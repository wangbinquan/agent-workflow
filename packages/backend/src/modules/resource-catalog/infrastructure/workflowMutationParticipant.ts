// RFC-401 A3 —— workflow 的唯一写入参与者（design §9.4）。
//
// 普通 CRUD（新建、复制、保存）、Intent、资源包与内建 workflow 目录都经这里写 workflow 行，全部 SQL 在调用方传入的事务上
// 执行。规则与错误就是普通编辑此前的那一份（用户 2026-11-02 确认以它为准）：
//   定义迁移到最新版本并要求规范 agent id（`workflow-agent-id-required`）→ 更新时按当前行回填打码的特权节点 →
//   场景规则（改名等）→ 脚本 / 代码托管作者门（`script-author-forbidden` / `code-host-author-forbidden`，只看敏感投影是否改变）→
//   快照 schema → 新增引用的可见性（`acl-missing-refs`，details.missing；agent id 不存在允许悬空到启动期，名字域
//   dangle-tolerant）→ 版本 fence（`resource-operation-stale`，details.current）与 already-current → 写入。
// workflow 不判重名，保存时也不做完整图校验（proposal §5 第 2、8 项）。名称格式是入口格式：普通编辑由请求 schema 与改名
// 校验负责，Intent 由变更集 schema，资源包由包 payload schema（历史名称可导入），参与者只要求快照 schema。
//
// 此前 Intent 与资源包各写一份：Intent 拒绝重名、对不存在的 agent id 报 `acl-missing-refs`、名字不可见时逐个报且不带
// details、stale 不带 details、作者门措辞不同；资源包不跑作者门之外的共同规则（规范 agent id、名字可见性），stale 措辞不同。

import {
  migrateWorkflowDefinitionToLatest,
  privilegedNodeLensFor,
  rehydratePrivilegedNodes,
  serializeWorkflowDefinitionStorageV1,
  serializeWorkflowEditableSnapshotV1,
  WorkflowDraftSnapshotSchema,
  type Workflow,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { eq, inArray } from 'drizzle-orm'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { assertCodeHostAuthorAllowed } from '@/services/codeHostAuthorGate'
import { assertScriptAuthorAllowed, type ScriptAuthorPrincipal } from '@/services/scriptAuthorGate'
import { NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import type { Actor } from '@/auth/actor'
import type { WorkflowDefinitionWriteParticipant } from '../application/ports/workflowDefinitionWrite'
import type {
  WorkflowMutationBatch,
  WorkflowMutationOwner,
  WorkflowMutationParticipant,
} from '../application/ports/workflowMutation'
import { isVisibleRow, type AclRow } from '../domain/resourceAccess'
import {
  extractWorkflowAgentRefs,
  extractWorkflowWorkflowRefs,
  extractWorkflowWorkgroupRefs,
} from './legacy/resourceRefs'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'
import { grantedResourceIdsFor } from './resourceVisibility'
import {
  assertWorkflowCatalogIdWritable,
  workflowCatalogPredicate,
} from './workflowCatalogPredicate'
import { createWorkflowDefinitionWriteParticipant } from './workflowDefinitionWrite'
import {
  assertCanonicalWorkflowAgentIds,
  workflowDraftSnapshotOf,
  workflowFromPersistenceRow,
  workflowRevisionOf,
} from './workflowPersistence'

type ReferenceType = 'agent' | 'workflow' | 'workgroup'

interface ReferenceRow extends AclRow {
  readonly id: string
  readonly name: string
  readonly ownerUserId: string | null
  readonly visibility: 'public' | 'private'
}

function notFound(id: string): NotFoundError {
  return new NotFoundError('workflow-not-found', `workflow '${id}' not found`)
}

/** 版本冲突带当前修订（编辑器据此提示重载）。 */
function stale(id: string, current: Workflow) {
  return staleConflictError('workflow', `workflow '${id}' changed; reload`, {
    current: workflowRevisionOf(current),
  })
}

function principalOf(
  owner: WorkflowMutationOwner,
  provenance: 'authored' | 'verbatim-copy',
): ScriptAuthorPrincipal {
  if (owner.kind === 'system') return { kind: 'system', reason: owner.reason }
  return provenance === 'verbatim-copy'
    ? { kind: 'verbatim-copy' }
    : { kind: 'actor', actor: owner.actor }
}

/** 迁移到最新版本并要求规范 agent id——编辑器、YAML 解析、Intent 与资源包都在写入边界之前给出 id。 */
function canonicalDefinition(definition: WorkflowDefinition): WorkflowDefinition {
  const migrated = migrateWorkflowDefinitionToLatest(definition)
  assertCanonicalWorkflowAgentIds(migrated)
  return migrated
}

function assertAuthorGates(
  principal: ScriptAuthorPrincipal,
  next: WorkflowDefinition,
  previous?: WorkflowDefinition,
): void {
  assertScriptAuthorAllowed({ next, previous, principal })
  // RFC-269：同一份 provenance（两种 principal 类型按设计结构相同）。
  assertCodeHostAuthorAllowed({ next, previous, principal })
}

function referenceGroups(definition: WorkflowDefinition): ReadonlyArray<{
  readonly type: ReferenceType
  readonly domain: 'id' | 'name'
  readonly values: readonly string[]
}> {
  return [
    { type: 'agent', domain: 'id', values: [...extractWorkflowAgentRefs(definition)] },
    { type: 'workflow', domain: 'name', values: extractWorkflowWorkflowRefs(definition) },
    { type: 'workgroup', domain: 'name', values: extractWorkflowWorkgroupRefs(definition) },
  ]
}

async function loadReferenceRows(
  transaction: ResourceCatalogTransaction,
  type: ReferenceType,
  domain: 'id' | 'name',
  values: readonly string[],
): Promise<readonly ReferenceRow[]> {
  if (values.length === 0) return []
  const selected = [...new Set(values)]
  const { agents, workflows, workgroups } = tablesOf(transaction)
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
        .where(inArray(domain === 'id' ? agents.id : agents.name, selected))
    case 'workflow':
      return transaction
        .select({
          id: workflows.id,
          name: workflows.name,
          ownerUserId: workflows.ownerUserId,
          visibility: workflows.visibility,
        })
        .from(workflows)
        .where(
          workflowCatalogPredicate(
            workflows.id,
            inArray(domain === 'id' ? workflows.id : workflows.name, selected),
          ),
        )
    case 'workgroup':
      return transaction
        .select({
          id: workgroups.id,
          name: workgroups.name,
          ownerUserId: workgroups.ownerUserId,
          visibility: workgroups.visibility,
        })
        .from(workgroups)
        .where(inArray(domain === 'id' ? workgroups.id : workgroups.name, selected))
  }
}

/**
 * 新增引用的可见性（D15 / RFC-243 §5.3）：只有存在但对写入者不可见的引用被拒；不存在的 agent id 允许悬空到校验 / 启动期，
 * 名字域 dangle-tolerant（解析不到任何行不是 ACL 违规）。更新只看相对当前定义新增的引用；本批新建的名字视为可见。
 */
async function assertDefinitionReferences(input: {
  readonly transaction: ResourceCatalogTransaction
  readonly actor: Actor
  readonly definition: WorkflowDefinition
  readonly previous?: WorkflowDefinition
  readonly batch?: WorkflowMutationBatch
}): Promise<void> {
  const previous = new Map(
    (input.previous === undefined ? [] : referenceGroups(input.previous)).map((group) => [
      `${group.type}:${group.domain}`,
      new Set(group.values),
    ]),
  )
  const missing: Array<{ readonly type: ReferenceType; readonly name: string }> = []
  for (const group of referenceGroups(input.definition)) {
    const grandfathered = previous.get(`${group.type}:${group.domain}`) ?? new Set<string>()
    const createdInBatch =
      group.type === 'agent' ? undefined : input.batch?.createdNames[group.type]
    const values = [...new Set(group.values)].filter(
      (value) => !grandfathered.has(value) && createdInBatch?.has(value) !== true,
    )
    if (values.length === 0) continue
    const [rows, grants] = await Promise.all([
      loadReferenceRows(input.transaction, group.type, group.domain, values),
      grantedResourceIdsFor(input.transaction, input.actor, group.type),
    ])
    if (group.domain === 'id') {
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const value of values) {
        const row = byId.get(value)
        if (row !== undefined && !isVisibleRow(input.actor, row, grants)) {
          missing.push({ type: group.type, name: value })
        }
      }
      continue
    }
    const byName = new Map<string, ReferenceRow[]>()
    for (const row of rows) {
      const bucket = byName.get(row.name) ?? []
      bucket.push(row)
      byName.set(row.name, bucket)
    }
    for (const value of values) {
      const matches = byName.get(value)
      if (matches !== undefined && !matches.some((row) => isVisibleRow(input.actor, row, grants))) {
        missing.push({ type: group.type, name: value })
      }
    }
  }
  if (missing.length > 0) {
    throw new ValidationError(
      'acl-missing-refs',
      `you do not have access to: ${missing.map((entry) => `${entry.type} '${entry.name}'`).join(', ')}`,
      { missing },
    )
  }
}

export interface WorkflowMutationParticipantDependencies {
  readonly now?: () => number
}

export function createWorkflowMutationParticipant(
  transaction: ResourceCatalogTransaction,
  dependencies: WorkflowMutationParticipantDependencies = {},
): WorkflowMutationParticipant {
  const now = dependencies.now ?? Date.now
  return Object.freeze<WorkflowMutationParticipant>({
    async create(owner, input) {
      assertWorkflowCatalogIdWritable(input.id)
      const provenance = input.provenance ?? 'authored'
      // 复制的是一份已入库修订：只迁移版本，不因源行的历史形状失败。
      const definition =
        provenance === 'verbatim-copy'
          ? migrateWorkflowDefinitionToLatest(input.content.definition)
          : canonicalDefinition(input.content.definition)
      assertAuthorGates(principalOf(owner, provenance), definition)
      const candidate = WorkflowDraftSnapshotSchema.parse({
        name: input.content.name,
        description: input.content.description,
        definition,
      })
      if (owner.kind === 'actor') {
        await assertDefinitionReferences({
          transaction,
          actor: owner.actor,
          definition: candidate.definition,
          ...(input.batch === undefined ? {} : { batch: input.batch }),
        })
      }
      const at = now()
      const created = await first(
        createWorkflowDefinitionWriteParticipant(transaction).insert({
          id: input.id,
          name: candidate.name,
          description: candidate.description,
          definition: serializeWorkflowDefinitionStorageV1(candidate.definition),
          version: 1,
          // RFC-231：用户资源 private；框架内建 public。
          ...(owner.kind === 'system'
            ? { ownerUserId: owner.userId, visibility: 'public' as const, builtin: true }
            : { ownerUserId: owner.actor.user.id, visibility: 'private' as const, builtin: false }),
          aclRevision: 0,
          createdAt: at,
          updatedAt: at,
        }),
      )
      if (created === undefined) throw new Error('workflow insert returned no row')
      return workflowFromPersistenceRow(created)
    },

    async update(owner, input) {
      const { workflows } = tablesOf(transaction)
      const row = await first(
        transaction
          .select()
          .from(workflows)
          .where(workflowCatalogPredicate(workflows.id, eq(workflows.id, input.id))),
      )
      if (row === undefined) throw notFound(input.id)
      const current = workflowFromPersistenceRow(row)
      const content = await input.patch(current)
      const canonical = canonicalDefinition(content.definition)
      // RFC-270：没有作者权的写入者看到、送回的是打码后的定义，按当前行回填正文后再过门、再写库。
      const definition =
        owner.kind === 'actor'
          ? rehydratePrivilegedNodes(
              canonical,
              current.definition,
              privilegedNodeLensFor(owner.actor),
            )
          : canonical
      // 场景规则在规范 agent id 之后：普通编辑此前的首错顺序（W16 锁定）。
      const name =
        input.guard === undefined ? content.name : await input.guard(current, content.name)
      assertAuthorGates(principalOf(owner, 'authored'), definition, current.definition)
      const candidate = WorkflowDraftSnapshotSchema.parse({
        name,
        description: content.description,
        definition,
      })
      if (owner.kind === 'actor') {
        await assertDefinitionReferences({
          transaction,
          actor: owner.actor,
          definition: candidate.definition,
          previous: current.definition,
          ...(input.batch === undefined ? {} : { batch: input.batch }),
        })
      }
      const logicalSame =
        serializeWorkflowEditableSnapshotV1(workflowDraftSnapshotOf(current)) ===
        serializeWorkflowEditableSnapshotV1(candidate)
      if (current.version !== input.expectedVersion) {
        if (!logicalSame) throw stale(input.id, current)
        return { workflow: current, snapshot: candidate, outcome: 'already-current' }
      }
      const storage = serializeWorkflowDefinitionStorageV1(candidate.definition)
      if (logicalSame && row.definition === storage) {
        return { workflow: current, snapshot: candidate, outcome: 'already-current' }
      }
      const changed = await first(
        createWorkflowDefinitionWriteParticipant(transaction).update({
          id: input.id,
          expectedVersion: input.expectedVersion,
          set: {
            name: candidate.name,
            description: candidate.description,
            definition: storage,
            version: current.version + 1,
            updatedAt: now(),
          },
        }),
      )
      if (changed === undefined) throw stale(input.id, current)
      return {
        workflow: workflowFromPersistenceRow(changed),
        snapshot: candidate,
        outcome: 'committed',
      }
    },
  })
}

type WorkflowSeedRecord = Parameters<WorkflowDefinitionWriteParticipant['insert']>[0]
type WorkflowSeedSet = Parameters<WorkflowDefinitionWriteParticipant['update']>[0]['set']

/**
 * 演示目录与融合内建的种子写入：受信任的平台内容，按给定的所有者与 ACL 原样落行（演示样例 public 但非 builtin），
 * 不经作者门与可见性判定——与此前两处直接写行相同。
 */
export async function insertSeedWorkflow(
  transaction: ResourceCatalogTransaction,
  record: WorkflowSeedRecord,
): Promise<void> {
  await createWorkflowDefinitionWriteParticipant(transaction).insert(record)
}

/** 融合内建 workflow 的修复写（定义修复与所有权漂移纠正）：新定义与版本，外加需要纠正的 ACL 列。 */
export async function repairSeedWorkflow(
  transaction: ResourceCatalogTransaction,
  repair: { readonly id: string; readonly set: WorkflowSeedSet },
): Promise<void> {
  await createWorkflowDefinitionWriteParticipant(transaction).update({
    id: repair.id,
    // 可编辑字段显式写出：RFC-199 的写入清单按 set 里的字段区分「可编辑更新」与「元数据更新」。
    set: { ...repair.set, definition: repair.set.definition, version: repair.set.version },
  })
}
