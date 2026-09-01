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

import type { Actor } from '@/auth/actor'
import { hasResourceAclBypass } from '@/modules/resource-catalog/domain/resourceAccess'
import { ForbiddenError, NotFoundError } from '@/util/errors'

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
    getCaseAcl(caseId: string): Promise<CaseAclRow | null>
    getCaseMemberRole(caseId: string, userId: string): Promise<CaseMemberRole | null>
    listCaseMembers(caseId: string): Promise<readonly CaseMemberRow[]>
  }
  readonly commands: {
    replaceCaseMembers(input: {
      readonly caseId: string
      readonly ownerUserId: string | null
      readonly members: readonly CaseMemberRow[]
      readonly addedBy: string
      readonly now: number
    }): Promise<{
      readonly previousOwnerUserId: string | null
      readonly previousMemberUserIds: readonly string[]
    }>
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
export async function loadVisibleCase(
  runtime: EmployeeCaseRuntime,
  actor: Actor,
  caseId: string,
): Promise<CaseAclRow> {
  const row = await runtime.queries.getCaseAcl(caseId)
  if (row === null) {
    throw new NotFoundError('employee-case-not-found', 'employee case not found')
  }
  const role = await runtime.queries.getCaseMemberRole(caseId, actor.user.id)
  if (!canViewCase(actor, row, role)) {
    throw new NotFoundError('employee-case-not-found', 'employee case not found')
  }
  return row
}

export async function requireCaseOperator(
  runtime: EmployeeCaseRuntime,
  actor: Actor,
  caseId: string,
): Promise<CaseAclRow> {
  const row = await loadVisibleCase(runtime, actor, caseId)
  const role = await runtime.queries.getCaseMemberRole(caseId, actor.user.id)
  if (canOperateCase(actor, row, role)) return row
  throw new ForbiddenError(
    'employee-case-observer-read-only',
    'you can only watch this employee case; resuming, terminating and policy upgrades are reserved for its owner and collaborators',
  )
}

export async function requireCaseOwner(
  runtime: EmployeeCaseRuntime,
  actor: Actor,
  caseId: string,
): Promise<CaseAclRow> {
  const row = await loadVisibleCase(runtime, actor, caseId)
  if (canManageCaseMembers(actor, row)) return row
  throw new ForbiddenError(
    'forbidden',
    'only the employee case owner or an actor with resource-acl:bypass can manage members',
  )
}
