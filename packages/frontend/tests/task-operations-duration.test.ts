import type { TaskOperationsListItem } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'

import { taskOperationsDuration } from '../src/lib/task-operations-duration'

type DurationInput = Pick<TaskOperationsListItem, 'status' | 'startedAt' | 'executionClock'>

function input(overrides: Partial<DurationInput>): DurationInput {
  return {
    status: 'done',
    startedAt: 1_000,
    executionClock: { runningMs: 0, runningSince: null },
    ...overrides,
  }
}

describe('taskOperationsDuration — RFC-207 execution clock', () => {
  test('pending reports queue wall-clock time', () => {
    expect(taskOperationsDuration(input({ status: 'pending', startedAt: 1_000 }), 121_000)).toEqual(
      {
        kind: 'queued',
        dur: { key: 'min', opts: { m: 2 } },
      },
    )
  })

  test('running adds only the current running segment to accumulated execution', () => {
    expect(
      taskOperationsDuration(
        input({
          status: 'running',
          startedAt: 1_000,
          executionClock: { runningMs: 120_000, runningSince: 301_000 },
        }),
        481_000,
      ),
    ).toEqual({ kind: 'running', dur: { key: 'min', opts: { m: 5 } } })
  })

  test('human/review waiting never adds parked wall-clock time', () => {
    expect(
      taskOperationsDuration(
        input({
          status: 'awaiting_human',
          startedAt: 1_000,
          executionClock: { runningMs: 180_000, runningSince: null },
        }),
        3_601_000,
      ),
    ).toEqual({ kind: 'accumulated', dur: { key: 'min', opts: { m: 3 } } })
  })

  test('zero accumulated execution is an em-dash token', () => {
    expect(taskOperationsDuration(input({ status: 'failed' }), 10_000)).toEqual({ kind: 'dash' })
  })
})
