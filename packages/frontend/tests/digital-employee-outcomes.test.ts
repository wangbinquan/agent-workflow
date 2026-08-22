// RFC-310 T212 — the card projection must combine both cutover ledgers without
// dropping unknown terminal kinds or counting another employee's work.

import { describe, expect, test } from 'vitest'

import { employeeTerminalOutcomeCounts } from '@/components/digital-employees/outcomes'

describe('digital employee card outcome buckets', () => {
  test('combines runtime and legacy groups into the four deterministic buckets', () => {
    expect(
      employeeTerminalOutcomeCounts('employee-1', [
        [
          { employeeId: 'employee-1', terminalKind: 'merged', count: 2 },
          { employeeId: 'employee-1', terminalKind: 'execution-failed', count: 1 },
          { employeeId: 'employee-2', terminalKind: 'merged', count: 99 },
        ],
        [
          { employeeId: 'employee-1', terminalKind: 'completed-no-change', count: 3 },
          { employeeId: 'employee-1', terminalKind: 'closed-unmerged', count: 4 },
          { employeeId: 'employee-1', terminalKind: 'future-terminal-kind', count: 5 },
          { employeeId: 'employee-1', terminalKind: 'failed', count: 6 },
        ],
      ]),
    ).toEqual({ merged: 2, noChange: 3, otherFinished: 9, failed: 7 })
  })
})
