// RFC-401 A3b —— workgroup 的唯一写入参与者（design §9.5）。
//
// 普通 CRUD（新建、复制、保存）、Intent 与资源包都经这里写 workgroup 行与成员行，全部 SQL 在调用方传入的事务上执行。规则、
// 错误与首错顺序就是普通编辑此前的那一份（用户 2026-11-02 确认以它为准）：
//   新建：人类成员须为 active 用户（`workgroup-member-user-invalid`，details.userIds）→ 存在但不可见的 agent 成员
//   （`acl-missing-refs`，details.missing）→ 不存在的 agent 成员（`workgroup-member-agent-invalid`，details.agentIds；复制时与不可见
//   同报 `acl-missing-refs`）→ 同 owner 同名（`workgroup-name-in-use`）→ 插入行与成员（leader 须是 agent 成员，
//   `workgroup-leader-invalid`）。
//   保存：人类成员 → 新增 agent 成员不存在或不可见（`acl-missing-refs`）→ 全部 agent 成员的存在性 → 版本 fence（`resource-operation-
//   stale`，details.current）与 already-current → 场景 guard（改名权限等）→ 改名后的名称冲突 → 写入；成员名单（含 leader）变了
//   才重建成员行。
// owner + name 唯一约束的竞争失败经 `engineOf(tx).uniqueViolationTarget` 归一为 `workgroup-name-in-use`（provider 中立）。
//
// 此前 Intent 与资源包各写一份：Intent 先判重名再校验成员、人类成员无效报 `workgroup-human-inactive`、对不存在的 agent 报
// `acl-missing-refs` 且 details 用 `id` 键、stale 不带 details、每次更新都重建成员行、leader 不匹配时静默置空；资源包逐个报不存在的
// agent、stale 措辞不同、成员快照的取法与普通编辑不同。

import {
  serializeWorkgroupEditableSnapshotV1,
  type Workgroup,
  type WorkgroupDraftMember,
  type WorkgroupDraftSnapshot,
} from '@agent-workflow/shared'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { ulid } from 'ulid'
import { engineOf } from '@/platform/persistence/databaseTransaction'
import { first } from '@/platform/persistence/queryHelpers'
import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf, type PersistenceTables } from '@/platform/persistence/sessionTables'
import { ConflictError, NotFoundError, ValidationError, staleConflictError } from '@/util/errors'
import type {
  WorkgroupMutationParticipant,
  WorkgroupUpdateResult,
} from '../application/ports/workgroupMutation'
import {
  assertAgentIdsUsableInTransaction,
  assertNoMissingResourceRefs,
} from './referenceUsability'
import type { ResourceCatalogTransaction } from './resourceCatalogTransaction'
import {
  resolveWorkgroupLeaderMemberId,
  workgroupContentPersistenceValues,
  workgroupDraftSnapshotOf,
  workgroupFromCopiedRows,
  workgroupMemberPersistenceValues,
  workgroupRevisionOf,
} from './workgroupPersistence'

type WorkgroupRow = PersistenceTables['workgroups']['$inferSelect']
type MemberRow = PersistenceTables['workgroupMembers']['$inferSelect']
type MemberValues = PersistenceTables['workgroupMembers']['$inferInsert']

function notFound(id: string): NotFoundError {
  return new NotFoundError('workgroup-not-found', `workgroup '${id}' not found`)
}

function agentIdsOf(members: readonly WorkgroupDraftMember[]): string[] {
  return [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
      ),
    ),
  ]
}

function rosterBytes(snapshot: WorkgroupDraftSnapshot): string {
  return JSON.stringify({
    leaderDisplayName: snapshot.leaderDisplayName ?? null,
    members: snapshot.members,
  })
}

async function assertHumansActive(
  transaction: ResourceCatalogTransaction,
  members: readonly WorkgroupDraftMember[],
): Promise<void> {
  const ids = [
    ...new Set(
      members.flatMap((member) =>
        member.memberType === 'human' && member.userId ? [member.userId] : [],
      ),
    ),
  ]
  if (ids.length === 0) return
  const { users } = tablesOf(transaction)
  const rows = await transaction
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(inArray(users.id, ids))
  const active = new Set(rows.filter((row) => row.status === 'active').map((row) => row.id))
  const invalid = ids.filter((id) => !active.has(id))
  if (invalid.length > 0) {
    throw new ValidationError('workgroup-member-user-invalid', 'human member user(s) not active', {
      userIds: invalid,
    })
  }
}

/** agent 成员的名字（写进成员行）；不存在的 id 报 `workgroup-member-agent-invalid`。 */
async function agentNames(
  transaction: ResourceCatalogTransaction,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const { agents } = tablesOf(transaction)
  const rows =
    ids.length === 0
      ? []
      : await transaction
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(inArray(agents.id, [...ids]))
  const names = new Map(rows.map((row) => [row.id, row.name]))
  const missing = ids.filter((id) => !names.has(id))
  if (missing.length > 0) {
    throw new ValidationError('workgroup-member-agent-invalid', 'agent member id(s) do not exist', {
      agentIds: missing,
    })
  }
  return names
}

/** owner + name 唯一冲突：PG 给约束名 `workgroups_owner_name_unique`，SQLite 给列清单 `workgroups.owner_user_id, …`。 */
function isOwnerNameConflict(transaction: ResourceCatalogTransaction, error: unknown): boolean {
  const target = engineOf(transaction).uniqueViolationTarget(error)
  return target !== undefined && /workgroups[._](?:owner|name)/i.test(target)
}

async function readWorkgroup(
  transaction: ResourceCatalogTransaction,
  id: string,
): Promise<{ readonly row: WorkgroupRow; readonly members: MemberRow[] } | undefined> {
  const { workgroups, workgroupMembers } = tablesOf(transaction)
  const row = await first(transaction.select().from(workgroups).where(eq(workgroups.id, id)))
  if (row === undefined) return undefined
  const members = await transaction
    .select()
    .from(workgroupMembers)
    .where(eq(workgroupMembers.workgroupId, id))
  return { row, members }
}

async function insertMembers(
  transaction: ResourceCatalogTransaction,
  values: readonly MemberValues[],
): Promise<void> {
  const { workgroupMembers } = tablesOf(transaction)
  for (const value of values) await insertOne(transaction, workgroupMembers, value)
}

export interface WorkgroupMutationParticipantDependencies {
  readonly now?: () => number
  /** 成员行 id。 */
  readonly memberId?: () => string
}

export function createWorkgroupMutationParticipant(
  transaction: ResourceCatalogTransaction,
  dependencies: WorkgroupMutationParticipantDependencies = {},
): WorkgroupMutationParticipant {
  const now = dependencies.now ?? Date.now
  const memberId = dependencies.memberId ?? ulid

  /** 名称在 owner 的命名空间里唯一（更新时是当前 owner 的命名空间，不是写入者的）。 */
  async function assertNameAvailable(
    ownerUserId: string | null,
    name: string,
    message: string,
    excludeId?: string,
  ): Promise<void> {
    const { workgroups } = tablesOf(transaction)
    const owner =
      ownerUserId === null
        ? isNull(workgroups.ownerUserId)
        : eq(workgroups.ownerUserId, ownerUserId)
    const identity = and(owner, eq(workgroups.name, name))
    const collision = await first(
      transaction
        .select({ id: workgroups.id })
        .from(workgroups)
        .where(excludeId === undefined ? identity : and(identity, ne(workgroups.id, excludeId))),
    )
    if (collision !== undefined) throw new ConflictError('workgroup-name-in-use', message)
  }

  return Object.freeze<WorkgroupMutationParticipant>({
    async create(actor, input) {
      const snapshot = input.snapshot
      await assertHumansActive(transaction, snapshot.members)
      const ids = agentIdsOf(snapshot.members)
      const unusable = await assertAgentIdsUsableInTransaction(transaction, actor, ids)
      if (input.provenance === 'copy') {
        // 复制（RFC-231）此前是 fail-closed：不存在与不可见同样报 acl-missing-refs。
        assertNoMissingResourceRefs(unusable.map((name) => ({ type: 'agent' as const, name })))
      } else if (unusable.length > 0) {
        // 新建：只有存在但不可见的才是 acl-missing-refs；不存在的由下面的存在性校验报。
        const { agents } = tablesOf(transaction)
        const existing = new Set(
          (
            await transaction
              .select({ id: agents.id })
              .from(agents)
              .where(inArray(agents.id, [...unusable]))
          ).map((row) => row.id),
        )
        assertNoMissingResourceRefs(
          unusable
            .filter((id) => existing.has(id))
            .map((name) => ({ type: 'agent' as const, name })),
        )
      }
      const names = await agentNames(transaction, ids)
      const conflictMessage = `workgroup '${snapshot.name}' already exists`
      await assertNameAvailable(actor.user.id, snapshot.name, conflictMessage)
      const at = now()
      const members = workgroupMemberPersistenceValues(
        input.id,
        snapshot.members,
        at,
        names,
        memberId,
      )
      const { workgroups } = tablesOf(transaction)
      let row: WorkgroupRow | undefined
      try {
        row = await first(
          transaction
            .insert(workgroups)
            .values({
              ...workgroupContentPersistenceValues({
                id: input.id,
                document: snapshot,
                leaderMemberId: resolveWorkgroupLeaderMemberId(snapshot, members),
              }),
              ownerUserId: actor.user.id,
              visibility: 'private',
              aclRevision: 0,
              createdAt: at,
              updatedAt: at,
            })
            .returning(),
        )
      } catch (error) {
        if (isOwnerNameConflict(transaction, error)) {
          throw new ConflictError('workgroup-name-in-use', conflictMessage)
        }
        throw error
      }
      if (row === undefined) throw new Error('workgroup insert returned no row')
      await insertMembers(transaction, members)
      const persisted = await readWorkgroup(transaction, input.id)
      if (persisted === undefined) throw new Error('workgroup insert was not readable')
      return workgroupFromCopiedRows(persisted.row, persisted.members)
    },

    async update(actor, input): Promise<WorkgroupUpdateResult> {
      const read = await readWorkgroup(transaction, input.id)
      if (read === undefined) throw notFound(input.id)
      const { row } = read
      const current = workgroupFromCopiedRows(row, [...read.members])
      const currentSnapshot = workgroupDraftSnapshotOf(current)
      const candidate = await input.patch(current, currentSnapshot)
      await assertHumansActive(transaction, candidate.members)
      const ids = agentIdsOf(candidate.members)
      const previous = new Set(
        current.members.flatMap((member) =>
          member.memberType === 'agent' && member.agentId ? [member.agentId] : [],
        ),
      )
      // 新增的 agent 成员 fail-closed：不存在与不可见同样报 acl-missing-refs；沿用的成员只查存在性。
      assertNoMissingResourceRefs(
        (
          await assertAgentIdsUsableInTransaction(
            transaction,
            actor,
            ids.filter((id) => !previous.has(id)),
          )
        ).map((name) => ({ type: 'agent' as const, name })),
      )
      const names = await agentNames(transaction, ids)
      const currentRevision = workgroupRevisionOf(current)
      const logicalSame =
        serializeWorkgroupEditableSnapshotV1(currentSnapshot) ===
        serializeWorkgroupEditableSnapshotV1(candidate)
      if (row.version !== input.expectedVersion) {
        if (logicalSame) {
          return { workgroup: current, snapshot: currentSnapshot, outcome: 'already-current' }
        }
        throw staleConflictError(
          'workgroup',
          `workgroup '${input.id}' is at version ${row.version}, expected ${input.expectedVersion}`,
          { current: currentRevision },
        )
      }
      if (logicalSame) {
        return { workgroup: current, snapshot: currentSnapshot, outcome: 'already-current' }
      }
      const name =
        input.guard === undefined ? candidate.name : await input.guard(current, candidate.name)
      const renameMessage = `workgroup '${name}' already exists; pick a different name`
      if (name !== current.name) {
        await assertNameAvailable(current.ownerUserId ?? null, name, renameMessage, input.id)
      }
      const next = { ...candidate, name }
      const at = now()
      const replacement =
        rosterBytes(currentSnapshot) === rosterBytes(next)
          ? null
          : workgroupMemberPersistenceValues(input.id, next.members, at, names, memberId)
      const { workgroups, workgroupMembers } = tablesOf(transaction)
      const content = workgroupContentPersistenceValues({
        id: input.id,
        document: next,
        leaderMemberId:
          replacement === null
            ? row.leaderMemberId
            : resolveWorkgroupLeaderMemberId(next, replacement),
      })
      let updated: WorkgroupRow | undefined
      try {
        updated = await first(
          transaction
            .update(workgroups)
            .set({
              name: content.name,
              description: content.description,
              instructions: content.instructions,
              mode: content.mode,
              outputContract: content.outputContract,
              leaderMemberId: content.leaderMemberId,
              shareOutputs: content.shareOutputs,
              directMessages: content.directMessages,
              blackboard: content.blackboard,
              maxRounds: content.maxRounds,
              completionGate: content.completionGate,
              clarifyBudget: content.clarifyBudget,
              fanOut: content.fanOut,
              version: row.version + 1,
              updatedAt: at,
            })
            .where(and(eq(workgroups.id, input.id), eq(workgroups.version, input.expectedVersion)))
            .returning(),
        )
      } catch (error) {
        if (isOwnerNameConflict(transaction, error)) {
          throw new ConflictError('workgroup-name-in-use', renameMessage)
        }
        throw error
      }
      if (updated === undefined) {
        throw staleConflictError('workgroup', `workgroup '${input.id}' changed; reload`, {
          current: currentRevision,
        })
      }
      if (replacement !== null) {
        await transaction.delete(workgroupMembers).where(eq(workgroupMembers.workgroupId, input.id))
        await insertMembers(transaction, replacement)
      }
      const persisted = await readWorkgroup(transaction, input.id)
      if (persisted === undefined) throw new Error('workgroup update was not readable')
      const workgroup = workgroupFromCopiedRows(persisted.row, persisted.members)
      return {
        workgroup,
        snapshot: workgroupDraftSnapshotOf(workgroup),
        outcome: 'committed',
      }
    },
  })
}

/** 只读的当前快照（Intent 与资源包按它判 no-op、补缺省字段）。 */
export function workgroupSnapshotOf(group: Workgroup): WorkgroupDraftSnapshot {
  return workgroupDraftSnapshotOf(group)
}
