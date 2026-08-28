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
  /** 全家族根前缀（tasks 列表页 + 列表面 WS 规则的全量失效键）。 */
  root: (): QueryKey => ['tasks'],
  /** GET /api/tasks/:id —— 详情行（tasks.detail 主查询同 key；亦是 per-task 子 key 的 reconcile 前缀）。 */
  detail: (taskId: string | null): QueryKey => ['tasks', taskId],
  /** lifecycle.alert 面（StuckTaskBanner 订阅、useTasksSync 规则表失效）。 */
  alerts: (taskId: string): QueryKey => ['tasks', taskId, 'alerts'],
  diff: (taskId: string | null): QueryKey => ['tasks', taskId, 'diff'],
  nodeRuns: (taskId: string | null): QueryKey => ['tasks', taskId, 'node-runs'],
  questions: (taskId: string | null): QueryKey => ['task-questions', taskId],
  clarifyDirectives: (taskId: string | null): QueryKey => ['task-clarify-directives', taskId],
  /**
   * 成员面板（TaskMembersPanel）的**编辑快照**。刻意不在 `['tasks', taskId]` 之下：
   * 面板把「管理会话仍有效」定义为这个 query `status === 'success' && fetchStatus === 'idle'`
   * （沿用 AclPanel / useActor 的「后台 refetch 期间保留的数据不算当前授权」不变量），
   * 于是任何把它打成 fetching 的失效都会被当成「失去管理权」——草稿整体重置、Save 变灰、
   * UserPicker 的 onChange 静默丢弃选择。而 `['tasks', taskId]` 是 useTaskSync 的
   * reconcile 前缀（每次 WS 建连 + 每一帧 task.status / task.done / review / clarify 都会
   * 失效它），任务在跑的几秒里必然命中打开着的面板：e2e `collab-multi-user.spec.ts` 的
   * 「grants a collaborator」在 Windows 分片上就是这样红的（单跑绿、全量红）。
   * 与 `['acl', …]`（useWebSocket.ts 刻意不碰它）和上面 questions / clarifyDirectives
   * 的出前缀是同一条规则；task-sync-rules.test.ts 钉死它不会被这张表触达。
   */
  members: (taskId: string | null, authRevision: number): QueryKey => [
    'task-members',
    taskId,
    authRevision,
  ],
  reviewers: (taskId: string | null, authRevision: number): QueryKey => [
    'task-reviewers',
    taskId,
    authRevision,
  ],
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
