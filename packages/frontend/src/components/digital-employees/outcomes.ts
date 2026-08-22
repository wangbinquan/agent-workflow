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

function outcomeBucket(terminalKind: string): keyof EmployeeTerminalOutcomeCounts {
  if (terminalKind === 'merged') return 'merged'
  if (terminalKind === 'completed-no-change' || terminalKind === 'no-change-confirmed') {
    return 'noChange'
  }
  if (terminalKind === 'failed' || terminalKind === 'blocked' || terminalKind.endsWith('-failed')) {
    return 'failed'
  }
  // Unknown terminal kinds must remain visible instead of disappearing from
  // the total. This bucket also contains closed/cancelled/operator termination.
  return 'otherFinished'
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
