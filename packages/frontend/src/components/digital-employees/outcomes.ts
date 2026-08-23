import { classifyTerminalKind } from '@agent-workflow/shared'
export interface EmployeeTerminalOutcomeGroup {
  employeeId: string
  terminalKind: string
  count: number
}

export interface EmployeeTerminalOutcomeCounts {
  merged: number
  noChange: number
  otherFinished: number
  failed: number
}

// RFC-317 T44（DE-06）—— 分桶走共享分类，不再就地手写第三张表。
//
// 这三张表（任务目录 / 协作 join / 本处分桶）此前互不一致，其中两张已经是错的。
// 词汇放在 shared 而不是后端模块里，正是因为本文件 import 不到后端——留在后端就必然
// 在这里被再抄一遍。未知终态仍然归 otherFinished（或按 `*-failed` 后缀归失败桶），
// 让它们从总数里消失比归错桶更糟。
function outcomeBucket(terminalKind: string): keyof EmployeeTerminalOutcomeCounts {
  return classifyTerminalKind(terminalKind).bucket
}

export function employeeTerminalOutcomeCounts(
  employeeId: string,
  sources: readonly (readonly EmployeeTerminalOutcomeGroup[])[],
): EmployeeTerminalOutcomeCounts {
  const counts: EmployeeTerminalOutcomeCounts = {
    merged: 0,
    noChange: 0,
    otherFinished: 0,
    failed: 0,
  }
  for (const group of sources.flat()) {
    if (group.employeeId !== employeeId) continue
    counts[outcomeBucket(group.terminalKind)] += group.count
  }
  return counts
}
