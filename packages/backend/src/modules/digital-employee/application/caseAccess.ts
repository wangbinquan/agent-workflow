// RFC-330 D19/D20 —— 数字员工案例的归属与成员制，与编排任务完整同形
// （`modules/collaboration/infrastructure/taskCollab.ts` 是它的镜像）：
//
//   可见   = 发起人 ∪ 案例成员（observer / collaborator）∪ tasks:read:all ∪ bypass
//   操作   = 发起人 ∪ collaborator ∪ bypass（resume / terminate / 策略升级）
//   管理成员 / 转移 owner = 发起人 ∪ bypass
//
// 成员表由 digital-employee context 自己拥有（`employee_case_members`，RFC-317 R5）。
// 判据只在入站绑定做一次（用户 2026-08-26 D21：不做事务内二次重验）。
//
// RFC-436：本文件原是 `services/employeeCaseMembers.ts`。判据是本 context 的规则，随
// HTTP 绑定一起归入 digital-employee。判据只读调用者的用户 id 与权限集合
// （`EmployeeCaseViewer`），越权写作 `resource-acl:bypass` 权限点——与 resource-catalog 的
// `hasResourceAclBypass` 同义；digital-employee 不依赖 resource-catalog（DAG 只允许反向）。

import type { Permission } from '@agent-workflow/shared'
import { ForbiddenError, NotFoundError } from '@/util/errors'

/** The caller a case rule decides for: its user id and effective permissions, never a full actor. */
export interface EmployeeCaseViewer {
  readonly user: Readonly<{ id: string }>
  readonly permissions: ReadonlySet<Permission>
}

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

/** 判据与成员管理需要的运行时切片；入站绑定把 `module.runtime` 原样传进来。 */
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

/**
 * The case authorization other contexts' case-scoped routes are mounted with
 * (development-automation's graph design routes). Bootstrap connects it; the
 * caller receives the visible case row or the same 404 / 403 the case routes give.
 */
export interface EmployeeCaseRouteAccess {
  authorize(viewer: EmployeeCaseViewer, caseId: string, edit: boolean): Promise<CaseAclRow>
}

function hasBypass(viewer: EmployeeCaseViewer): boolean {
  return viewer.permissions.has('resource-acl:bypass')
}

function isOwner(viewer: EmployeeCaseViewer, row: CaseAclRow): boolean {
  return row.ownerUserId !== null && row.ownerUserId === viewer.user.id
}

/** 与 `canViewTask`（taskCollab.ts）逐分支对齐。 */
export function canViewCase(
  viewer: EmployeeCaseViewer,
  row: CaseAclRow,
  role: CaseMemberRole | null,
): boolean {
  if (hasBypass(viewer) || viewer.permissions.has('tasks:read:all')) return true
  if (isOwner(viewer, row)) return true
  return role !== null
}

/** 与 `requireTaskOperator` 对齐：observer 与 tasks:read:all 都只能看。 */
export function canOperateCase(
  viewer: EmployeeCaseViewer,
  row: CaseAclRow,
  role: CaseMemberRole | null,
): boolean {
  if (hasBypass(viewer)) return true
  if (isOwner(viewer, row)) return true
  return role === 'collaborator'
}

export function canManageCaseMembers(viewer: EmployeeCaseViewer, row: CaseAclRow): boolean {
  return hasBypass(viewer) || isOwner(viewer, row)
}

/** 不可见与不存在同形（RFC-248 H9 反枚举）：都是 404 `employee-case-not-found`。 */
export async function loadVisibleCase(
  runtime: EmployeeCaseRuntime,
  viewer: EmployeeCaseViewer,
  caseId: string,
): Promise<CaseAclRow> {
  const row = await runtime.queries.getCaseAcl(caseId)
  if (row === null) {
    throw new NotFoundError('employee-case-not-found', 'employee case not found')
  }
  const role = await runtime.queries.getCaseMemberRole(caseId, viewer.user.id)
  if (!canViewCase(viewer, row, role)) {
    throw new NotFoundError('employee-case-not-found', 'employee case not found')
  }
  return row
}

export async function requireCaseOperator(
  runtime: EmployeeCaseRuntime,
  viewer: EmployeeCaseViewer,
  caseId: string,
): Promise<CaseAclRow> {
  const row = await loadVisibleCase(runtime, viewer, caseId)
  const role = await runtime.queries.getCaseMemberRole(caseId, viewer.user.id)
  if (canOperateCase(viewer, row, role)) return row
  throw new ForbiddenError(
    'employee-case-observer-read-only',
    'you can only watch this employee case; resuming, terminating and policy upgrades are reserved for its owner and collaborators',
  )
}

export async function requireCaseOwner(
  runtime: EmployeeCaseRuntime,
  viewer: EmployeeCaseViewer,
  caseId: string,
): Promise<CaseAclRow> {
  const row = await loadVisibleCase(runtime, viewer, caseId)
  if (canManageCaseMembers(viewer, row)) return row
  throw new ForbiddenError(
    'forbidden',
    'only the employee case owner or an actor with resource-acl:bypass can manage members',
  )
}

/** Edit → operator rule; read → visibility rule — the closure the case routes used to build inline. */
export function employeeCaseRouteAccess(runtime: EmployeeCaseRuntime): EmployeeCaseRouteAccess {
  return Object.freeze({
    authorize: (viewer: EmployeeCaseViewer, caseId: string, edit: boolean) =>
      edit
        ? requireCaseOperator(runtime, viewer, caseId)
        : loadVisibleCase(runtime, viewer, caseId),
  })
}
