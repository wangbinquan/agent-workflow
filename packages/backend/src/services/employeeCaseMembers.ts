// RFC-330 D19/D20 —— 数字员工案例的归属与成员制，与编排任务完整同形
// （`services/taskCollab.ts` 是它的镜像）：
//
//   可见   = 发起人 ∪ 案例成员（observer / collaborator）∪ tasks:read:all ∪ bypass
//   操作   = 发起人 ∪ collaborator ∪ bypass（resume / terminate / 策略升级）
//   管理成员 / 转移 owner = 发起人 ∪ bypass
//
// 成员表由 digital-employee context 自己拥有（`employee_case_members`，RFC-317 R5），
// 本文件只做 transport 层的判据、wire 装配（用户投影）、规范化与广播——规范化规则
// 与任务侧共用 `planMembersReplacement` / `assertMembersUsersActive`，不另写一份。
// 判据只在路由层做一次（用户 2026-08-26 D21：不做事务内二次重验）。

import type { CaseMembers, UpdateMembersBody, UserPublic } from '@agent-workflow/shared'
import { inArray } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { users } from '@/db/schema'
import { hasResourceAclBypass } from '@/services/resourceAcl'
import { assertMembersUsersActive, planMembersReplacement } from '@/services/taskCollab'
import { ForbiddenError, NotFoundError } from '@/util/errors'
import { TASKS_LIST_CHANNEL, tasksListBroadcaster } from '@/ws/broadcaster'

/** 案例归属的窄行（`runtime.queries.getCaseAcl`）。 */
export interface CaseAclRow {
  readonly id: string
  readonly ownerUserId: string | null
  readonly employeeId: string
}

export type CaseMemberRole = 'collaborator' | 'observer'

/** 一行案例成员（digital-employee store 的投影；owner 不在其中）。 */
export interface CaseMemberRow {
  readonly userId: string
  readonly role: CaseMemberRole
}

/**
 * 本服务需要的 digital-employee 运行时切片——**结构化**声明而不 import 模块的
 * composition 类型（RFC-317 R1：legacy 层不得 import 模块内部 / composition）。
 * `routes/digitalEmployees.ts` 把 `module.runtime` 原样传进来即可。
 */
export interface EmployeeCaseRuntime {
  readonly queries: {
    getCaseAcl(caseId: string): CaseAclRow | null
    getCaseMemberRole(caseId: string, userId: string): CaseMemberRole | null
    listCaseMembers(caseId: string): readonly CaseMemberRow[]
  }
  readonly commands: {
    replaceCaseMembers(input: {
      readonly caseId: string
      readonly ownerUserId: string | null
      readonly members: readonly CaseMemberRow[]
      readonly addedBy: string
      readonly now: number
    }): {
      readonly previousOwnerUserId: string | null
      readonly previousMemberUserIds: readonly string[]
    }
  }
}

function isOwner(actor: Actor, row: CaseAclRow): boolean {
  return row.ownerUserId !== null && row.ownerUserId === actor.user.id
}

/** 与 `canViewTask`（taskCollab.ts）逐分支对齐。 */
export function canViewCase(actor: Actor, row: CaseAclRow, role: CaseMemberRole | null): boolean {
  if (hasResourceAclBypass(actor) || actor.permissions.has('tasks:read:all')) return true
  if (isOwner(actor, row)) return true
  return role !== null
}

/** 与 `requireTaskOperator` 对齐：observer 与 tasks:read:all 都只能看。 */
export function canOperateCase(
  actor: Actor,
  row: CaseAclRow,
  role: CaseMemberRole | null,
): boolean {
  if (hasResourceAclBypass(actor)) return true
  if (isOwner(actor, row)) return true
  return role === 'collaborator'
}

export function canManageCaseMembers(actor: Actor, row: CaseAclRow): boolean {
  return hasResourceAclBypass(actor) || isOwner(actor, row)
}

/** 不可见与不存在同形（RFC-248 H9 反枚举）：都是 404 `employee-case-not-found`。 */
export function loadVisibleCase(
  runtime: EmployeeCaseRuntime,
  actor: Actor,
  caseId: string,
): CaseAclRow {
  const row = runtime.queries.getCaseAcl(caseId)
  if (row === null) {
    throw new NotFoundError('employee-case-not-found', 'employee case not found')
  }
  const role = runtime.queries.getCaseMemberRole(caseId, actor.user.id)
  if (!canViewCase(actor, row, role)) {
    throw new NotFoundError('employee-case-not-found', 'employee case not found')
  }
  return row
}

export function requireCaseOperator(
  runtime: EmployeeCaseRuntime,
  actor: Actor,
  caseId: string,
): CaseAclRow {
  const row = loadVisibleCase(runtime, actor, caseId)
  const role = runtime.queries.getCaseMemberRole(caseId, actor.user.id)
  if (canOperateCase(actor, row, role)) return row
  throw new ForbiddenError(
    'employee-case-observer-read-only',
    'you can only watch this employee case; resuming, terminating and policy upgrades are reserved for its owner and collaborators',
  )
}

export function requireCaseOwner(
  runtime: EmployeeCaseRuntime,
  actor: Actor,
  caseId: string,
): CaseAclRow {
  const row = loadVisibleCase(runtime, actor, caseId)
  if (canManageCaseMembers(actor, row)) return row
  throw new ForbiddenError(
    'forbidden',
    'only the employee case owner or an actor with resource-acl:bypass can manage members',
  )
}

type UserRow = typeof users.$inferSelect

function toUserPublic(row: UserRow): UserPublic {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  }
}

/** GET /api/employee-cases/:id/members —— 与 `getTaskMembers` 同形（`caseId` 变体）。 */
export async function getCaseMembers(
  db: DbClient,
  actor: Actor,
  runtime: EmployeeCaseRuntime,
  row: CaseAclRow,
): Promise<CaseMembers> {
  const memberRows = runtime.queries.listCaseMembers(row.id)
  const wanted = [
    ...new Set([
      ...(row.ownerUserId !== null ? [row.ownerUserId] : []),
      ...memberRows.map((m) => m.userId),
    ]),
  ]
  const userRows =
    wanted.length === 0 ? [] : await db.select().from(users).where(inArray(users.id, wanted))
  const byId = new Map(userRows.map((u) => [u.id, u]))
  const ownerRow =
    row.ownerUserId !== null && row.ownerUserId !== SYSTEM_USER_ID
      ? (byId.get(row.ownerUserId) ?? null)
      : null
  const members = memberRows.flatMap((m) => {
    const user = byId.get(m.userId)
    return user === undefined ? [] : [{ user: toUserPublic(user), role: m.role }]
  })
  const canManage = canManageCaseMembers(actor, row)
  const canOperate =
    canManage || memberRows.some((m) => m.role === 'collaborator' && m.userId === actor.user.id)
  return {
    caseId: row.id,
    ownerUserId: row.ownerUserId,
    owner: ownerRow === null ? null : toUserPublic(ownerRow),
    members,
    canManage,
    canOperate,
  }
}

/**
 * PUT /api/employee-cases/:id/members —— owner / bypass；`members` 全量替换、
 * `ownerUserId` 转移（前任降为 collaborator，D20）。规范化与任务侧共用；写入由
 * digital-employee store 在一个事务内完成；随后向统一列表频道广播 before ∪ after 受众。
 */
export async function updateCaseMembers(
  db: DbClient,
  actor: Actor,
  runtime: EmployeeCaseRuntime,
  row: CaseAclRow,
  body: UpdateMembersBody,
): Promise<CaseMembers> {
  if (!canManageCaseMembers(actor, row)) {
    throw new ForbiddenError(
      'forbidden',
      'only the employee case owner or an actor with resource-acl:bypass can manage members',
    )
  }
  await assertMembersUsersActive(db, body)
  const current = runtime.queries.listCaseMembers(row.id)
  const plan = planMembersReplacement({
    prevOwner: row.ownerUserId,
    requestedOwner: body.ownerUserId,
    requestedMembers: body.members,
    currentMembers: current.map((m) => ({ userId: m.userId, role: m.role })),
  })
  const committed = runtime.commands.replaceCaseMembers({
    caseId: row.id,
    ownerUserId: plan.nextOwner,
    members: [...plan.nextMembers].map(([userId, role]) => ({ userId, role })),
    addedBy: actor.user.id,
    now: Date.now(),
  })

  const visibleUserIds = new Set<string>()
  if (committed.previousOwnerUserId !== null) visibleUserIds.add(committed.previousOwnerUserId)
  if (plan.nextOwner !== null) visibleUserIds.add(plan.nextOwner)
  for (const userId of committed.previousMemberUserIds) visibleUserIds.add(userId)
  for (const userId of plan.nextMembers.keys()) visibleUserIds.add(userId)
  tasksListBroadcaster.broadcast(
    TASKS_LIST_CHANNEL,
    { type: 'employee-case.members.changed', caseId: row.id },
    { kind: 'employee-case.members-changed-audience', caseId: row.id, visibleUserIds },
  )

  return getCaseMembers(db, actor, runtime, { ...row, ownerUserId: plan.nextOwner })
}
