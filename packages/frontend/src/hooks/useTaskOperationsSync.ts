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
//
// 现在改成**就地同步**：任一帧到达即 `invalidateQueries`（默认 refetchType
// 'active'）——旧数据留在屏幕上，后台把已加载的各页重取一遍，全部拿到后原子
// 替换。行的 DOM 节点由 key 复用，于是状态 chip / 耗时就地变，滚动位置、展开
// 的子分支、翻出来的页都不丢；新任务与被删的任务也一并进出（用户 2026-08-26
// 明确要求「新行也自动进来」，横幅与手动刷新按钮随之删除）。
//
// 频率是安全的：这条频道只承载**任务级**事件（`emitTaskStatus` 在
// `services/task.ts:5759` 只在任务状态迁移时广播，全仓 10 个调用点），且
// `useWsInvalidation` 自带 1 秒 leading+trailing 合并窗口。

import type { TasksListWsMessage } from '@agent-workflow/shared'
import { WS_PATHS } from '@agent-workflow/shared'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { TASK_OPERATIONS_QUERY_KEY } from './useTaskOperationsPage'
import { useWsInvalidation, type WsInvalidationRules } from './useWsInvalidation'

/** 这条频道上会改变列表内容的全部帧型（RFC-244 原 DIRTY_TYPES 集合，逐条不变）。 */
const RULES: WsInvalidationRules<TasksListWsMessage> = {
  'task.created': () => [TASK_OPERATIONS_QUERY_KEY],
  'task.status': () => [TASK_OPERATIONS_QUERY_KEY],
  'task.deleted': () => [TASK_OPERATIONS_QUERY_KEY],
  'task.members.changed': () => [TASK_OPERATIONS_QUERY_KEY],
  'employee-case.members.changed': () => [TASK_OPERATIONS_QUERY_KEY],
  'lifecycle.alert': () => [TASK_OPERATIONS_QUERY_KEY],
  'lifecycle.alert.resolved': () => [TASK_OPERATIONS_QUERY_KEY],
}

/** WS 断开时的兜底重取节奏（与 RFC-244 原值一致）。 */
const DISCONNECTED_POLL_MS = 15_000

export function useTaskOperationsSync(): void {
  const queryClient = useQueryClient()
  const connection = useWsInvalidation<TasksListWsMessage>(WS_PATHS.tasksList, RULES)

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
