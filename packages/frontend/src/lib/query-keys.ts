// RFC-286 F4 —— WS 失效规则面的 queryKey 工厂（D16 定界：**只收编 WS 关联
// key**；各 route 文件里与 WS 无关的 inline key 不动）。
//
// 为什么存在：useTaskSync 的规则表曾散落 16+ 个字符串字面 key，与 route 侧的
// useQuery(key) 靠肉眼保持一致——任何一侧改拼写，失效就静默失联（页面只剩
// 15s 轮询兜底）。工厂化后规则表零字面（rfc286-f4 grep 锁钉死），route 侧
// 逐步换用同一符号。既有单源工厂（workgroupRoomKey / taskChildrenQueryKey）
// 保持原位，不重复收编。

import type { QueryKey } from '@tanstack/react-query'

export const TASK_QUERY_KEYS = {
  /** GET /api/tasks/:id —— 详情行（tasks.detail 主查询同 key）。 */
  detail: (taskId: string | null): QueryKey => ['tasks', taskId],
  /** 前缀 reconcile 用（detail/diff/node-runs/alerts 共享 ['tasks', id] 前缀）。 */
  detailPrefix: (taskId: string | null): QueryKey => ['tasks', taskId],
  diff: (taskId: string | null): QueryKey => ['tasks', taskId, 'diff'],
  nodeRuns: (taskId: string | null): QueryKey => ['tasks', taskId, 'node-runs'],
  questions: (taskId: string | null): QueryKey => ['task-questions', taskId],
  clarifyDirectives: (taskId: string | null): QueryKey => ['task-clarify-directives', taskId],
} as const

export const REVIEW_QUERY_KEYS = {
  /** 前缀 reconcile 用（list/detail/rounds/pending-count 共享 ['reviews'] 前缀）。 */
  prefix: (): QueryKey => ['reviews'],
  detail: (nodeRunId: string): QueryKey => ['reviews', 'detail', nodeRunId],
  list: (): QueryKey => ['reviews', 'list'],
  pendingCount: (): QueryKey => ['reviews', 'pending-count'],
  rounds: (nodeRunId: string): QueryKey => ['reviews', 'rounds', nodeRunId],
} as const

export const CLARIFY_QUERY_KEYS = {
  /** 前缀 reconcile 用。 */
  prefix: (): QueryKey => ['clarify'],
  detail: (nodeRunId: string): QueryKey => ['clarify', 'detail', nodeRunId],
  list: (): QueryKey => ['clarify', 'list'],
  pendingCount: (): QueryKey => ['clarify', 'pending-count'],
} as const
