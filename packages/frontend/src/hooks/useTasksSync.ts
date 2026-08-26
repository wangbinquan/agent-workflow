// Subscribe to /ws/tasks for instant list refresh. Replaces the 4s polling
// loop on the Tasks page once a WS connection is established; the polling
// fallback stays in place at a longer interval (15s) for the case where
// the daemon WS subsystem is temporarily unavailable.
//
// RFC-152 — thin wrapper over the useWsInvalidation rules table.

import { TASK_QUERY_KEYS } from '@/lib/query-keys'
import type { TasksListWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

const RULES: WsInvalidationRules<TasksListWsMessage> = {
  'task.created': () => [TASK_QUERY_KEYS.root()],
  'task.status': () => [TASK_QUERY_KEYS.root()],
  'task.deleted': () => [TASK_QUERY_KEYS.root()],
  'task.members.changed': () => [TASK_QUERY_KEYS.root()],
  // RFC-330 —— 案例归属 / 成员变了：统一列表的 owner 列、案例页投影与**页面级**成员查询
  // （恢复按钮门）重取。刻意**不碰** `['employee-case-members', …]`——那是成员面板的编辑快照
  // key，与 TASK_QUERY_KEYS.members 同一条规则：打成 fetching 会让 owner 保存后被判
  // 「失去管理权」、弹窗不关闭（e2e 旅程实撞）。
  'employee-case.members.changed': (msg) => [
    TASK_QUERY_KEYS.root(),
    ['employee-case', msg.caseId],
    ['employee-case-members-page', msg.caseId],
  ],
  // RFC-053 P-6: the banner on the detail page subscribes to
  // ['tasks', taskId, 'alerts']; refresh that query so a stuck task lights
  // up without waiting for the 30s poll fallback. Deliberately does NOT
  // touch the broad ['tasks'] key (saves a list-page round-trip).
  'lifecycle.alert': (msg) => [TASK_QUERY_KEYS.alerts(msg.taskId)],
  'lifecycle.alert.resolved': (msg) => [TASK_QUERY_KEYS.alerts(msg.taskId)],
}

export function useTasksSync(enabled: boolean = true): void {
  useWsInvalidation<TasksListWsMessage>(enabled ? WS_PATHS.tasksList : null, RULES, undefined, {
    reconcileOnOpen: () => [TASK_QUERY_KEYS.root()],
  })
}
