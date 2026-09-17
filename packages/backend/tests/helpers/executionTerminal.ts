// RFC-359 AC-1（plan §5hn 批次二 ⑦）—— 等任务走到终态并投影结果。
//
// 这段原本是 `services/execution/executor.ts#watchExecutionTerminal`。那个文件是 RFC-243 的
// 「统一执行门面」——它的核心 `startExecution` 是**启动编排的第二份写法**，已随两个引擎的启动路
// 合一整份退役；`watchExecutionTerminal` 的**生产消费者一直是零**，只有测试在用。
// 于是它挪到测试树里，而不是让一个没有生产消费者的文件继续存在。
//
// 它自己没有任何 provider 判断：`watchTaskTerminal` 与 `getExecutionOutcome` 都是中立实现。
import type { ProviderNeutralDatabase } from '@/db/query'
import type { ExecutionOutcome } from '@/services/execution/types'
import { getExecutionOutcome } from '@/services/execution/outcome'
import { watchTaskTerminal, type TerminalWatchResult } from '@/services/execution/executionWatch'

export type WatchExecutionResult =
  | { kind: 'outcome'; outcome: ExecutionOutcome }
  | { kind: 'missing' }
  | { kind: 'aborted' }

/**
 * `missing` = 任务行消失了（被删）——永不挂死；`aborted` = 调用方的 signal 先触发。
 */
export async function watchExecutionTerminal(
  db: ProviderNeutralDatabase,
  taskId: string,
  opts: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<WatchExecutionResult> {
  const result: TerminalWatchResult = await watchTaskTerminal(db, taskId, opts)
  if (result.kind === 'terminal') {
    return { kind: 'outcome', outcome: await getExecutionOutcome(db, taskId) }
  }
  return result
}
