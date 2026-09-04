// /tasks 列表页的实时同步。
//
// 2026-08-26 修复「任务列表一直在闪」：此前这里走的是 RFC-244 §5.3 的
// 「置脏横幅 + 15 秒整表重建」，而那次重建用的是 `queryClient.resetQueries`
// ——它把整棵 `['task-operations']` 缓存清回初始态，于是每一轮：
//
//   1. `query.isLoading` 翻 true ⇒ 整张列表被 `<LoadingState>` 顶替（空屏）；
//   2. `items.length` 归 0 ⇒ `TaskOperationsList` 连同 `VirtualList` 整个卸载，
//      重挂后**滚动位置回到顶部**；
//   3. 同前缀的每个展开着的子分支（`TaskChildren`）各自塌成一个 spinner。
//
// 只要有任务在跑，状态帧就不断把列表置脏，用户每 15 秒被这样打断一次。
// 改成**就地同步**后（任一帧到达即 `invalidateQueries`，旧数据留在屏幕上、后台重取、
// 拿到后原子替换），这三条都不再发生——它们仍是本文件的硬约束，测试锁着。
//
// ── RFC-357（2026-09-04）：先 patch，再稀疏地重取 ──────────────────────────
//
// 上面那版每一帧都触发一次「已加载各页全部重取」，1 秒合并窗口只是把上限压到每秒一次。
// 后端那半已经把单次重取降到 O(页)，所以这里要拿回来的是**延迟与重取次数**：
//
//   · `task.status` / `task.deleted` 先**就地应用**（`taskListFrames.ts` 的纯函数），
//     状态 chip 在帧到达的那一刻就变，不再等一次网络往返；
//   · 正因为屏幕已经对了，权威重取就不必那么急——合并窗口 1s → 10s，重取次数降一个量级。
//
// 刻意**没有**让 patch 取代重取。四个页签计数的分母是「所有非-view 匹配行」（含当前页看不
// 见的行与子行），缓存里只有当前几页的根行，据此加减必然在一部分情况下算错；而「页签数字
// 乱跳」正是用户 2026-09-04 报的第一个问题。数字仍然只由服务端给，只是给得稀疏了。
//
// 频率是安全的：这条频道只承载**任务级**事件（`emitTaskStatus` 只在任务状态迁移时广播）。

import type { TasksListWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import {
  applyTaskListFrame,
  type PatchableTaskListFrame,
  type TaskListPages,
} from './taskListFrames'
import { TASK_OPERATIONS_QUERY_KEY } from './useTaskOperationsPage'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

/** 就地应用一帧到每一份已加载的列表缓存（不同 filters / source / parent 各是一份）。 */
export function patchTaskOperationsCaches(
  queryClient: QueryClient,
  frame: PatchableTaskListFrame,
): void {
  for (const [key, data] of queryClient.getQueriesData<TaskListPages>({
    queryKey: TASK_OPERATIONS_QUERY_KEY,
  })) {
    if (data === undefined || !Array.isArray(data.pages)) continue
    const next = applyTaskListFrame(data, frame)
    // null = 这一帧与这份缓存无关；不写回，免得无谓地把它标脏重渲染。
    if (next !== null) queryClient.setQueryData(key, next)
  }
}

/** 这条频道上会改变列表内容的全部帧型（RFC-244 原 DIRTY_TYPES 集合，逐条不变）。 */
const RULES: WsInvalidationRules<TasksListWsMessage, QueryClient> = {
  // 就地改状态；重取仍会来（只是被合并窗口压稀），负责把权威数字与行的进出对齐。
  'task.status': (msg, queryClient) => {
    patchTaskOperationsCaches(queryClient, {
      type: 'task.status',
      taskId: msg.taskId,
      status: msg.status,
    })
    return [TASK_OPERATIONS_QUERY_KEY]
  },
  'task.deleted': (msg, queryClient) => {
    patchTaskOperationsCaches(queryClient, { type: 'task.deleted', taskId: msg.taskId })
    return [TASK_OPERATIONS_QUERY_KEY]
  },
  // 以下帧算不出来：新行是否命中当前 filters/scope/view、它的 owner / childCount / 层级，
  // 以及成员变更后的可见性，都只有服务端知道；`lifecycle.alert.resolved` 也不带剩余告警数。
  'task.created': () => [TASK_OPERATIONS_QUERY_KEY],
  'task.members.changed': () => [TASK_OPERATIONS_QUERY_KEY],
  'employee-case.members.changed': () => [TASK_OPERATIONS_QUERY_KEY],
  'lifecycle.alert': () => [TASK_OPERATIONS_QUERY_KEY],
  'lifecycle.alert.resolved': () => [TASK_OPERATIONS_QUERY_KEY],
}

/** WS 断开时的兜底重取节奏（与 RFC-244 原值一致）。 */
const DISCONNECTED_POLL_MS = 15_000

/** RFC-357：屏幕已由 patch 即时更新，权威重取因此可以稀疏一个量级。 */
export const TASK_LIST_COALESCE_MS = 10_000

export function useTaskOperationsSync(): void {
  const queryClient = useQueryClient()
  const connection = useWsInvalidation<TasksListWsMessage, QueryClient>(
    WS_PATHS.tasksList,
    RULES,
    queryClient,
    { coalesceMs: TASK_LIST_COALESCE_MS },
  )

  // 断线期间收不到帧，退回轮询；同样是保留数据的重取，不空屏。
  useEffect(() => {
    if (connection.connected) return
    const timer = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: TASK_OPERATIONS_QUERY_KEY })
    }, DISCONNECTED_POLL_MS)
    return () => window.clearInterval(timer)
  }, [connection.connected, queryClient])

  // 断线期间错过的帧不会补发，重连后补一次对账。**首次建连不算**——那一刻
  // 列表查询自己刚取过，再失效一次只会把它 cancel 掉重来（RFC-244 原有语义，
  // 这里逐字保留；因此不用 useWsInvalidation 的 reconcileOnOpen）。
  const previousEpoch = useRef(0)
  useEffect(() => {
    if (connection.connectionEpoch > 0 && previousEpoch.current > 0) {
      void queryClient.invalidateQueries({ queryKey: TASK_OPERATIONS_QUERY_KEY })
    }
    previousEpoch.current = connection.connectionEpoch
  }, [connection.connectionEpoch, queryClient])
}
