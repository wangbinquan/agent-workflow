// RFC-330 D19/D20 —— 案例页的成员入口：复用任务成员面板（`MembersDialogButton` +
// 资源适配器），只有 URL / 缓存键 / 响应 id 字段 / 失效键因资源而异。

import type { CaseMembers, MembersBase } from '@agent-workflow/shared'
import { MembersDialogButton, type MembersPanelAdapter } from '@/components/tasks/TaskMembersPanel'

/**
 * 成员面板的**编辑快照** key。与 `TASK_QUERY_KEYS.members` 同一条规则：面板把「管理会话仍
 * 有效」定义为这个 query `status === 'success' && fetchStatus === 'idle'`，所以 WS 帧 / 页面
 * 刷新**绝不能**失效它（否则 owner 自己保存后会被判「失去管理权」、弹窗不关闭）。
 */
export const CASE_MEMBERS_QUERY_KEY = (caseId: string, authRevision: number) =>
  ['employee-case-members', caseId, authRevision] as const

/**
 * 案例页自己读 `canOperate` 用的**页面级** key（恢复按钮门）。它可以被 WS 帧与面板保存
 * 失效——两者分开正是为了让编辑快照不被打成 fetching。
 */
export const CASE_MEMBERS_PAGE_QUERY_KEY = (caseId: string, authRevision: number) =>
  ['employee-case-members-page', caseId, authRevision] as const

export function caseMembersAdapter(caseId: string): MembersPanelAdapter {
  return {
    resourceId: caseId,
    membersUrl: `/api/employee-cases/${encodeURIComponent(caseId)}/members`,
    queryKey: (authRevision) => CASE_MEMBERS_QUERY_KEY(caseId, authRevision),
    responseId: (data: MembersBase) => (data as CaseMembers).caseId,
    // 案例页自己的投影（owner 变了）+ 页面级成员查询（恢复按钮门）+ 统一任务列表（owner 列）。
    invalidateKeys: [['employee-case', caseId], ['employee-case-members-page', caseId], ['tasks']],
  }
}

export function CaseMembersDialogButton({ caseId }: { caseId: string }) {
  return (
    <MembersDialogButton
      adapter={caseMembersAdapter(caseId)}
      testid="employee-case-members-dialog-button"
    />
  )
}
