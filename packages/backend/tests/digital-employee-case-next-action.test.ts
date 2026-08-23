// User regression 2026-08-23: a Case whose execution was waiting at a human
// review gate claimed that the digital employee would continue automatically.
// Keep next-action ownership in the digital-employee projection and make the
// exact review execution discoverable without task-list special casing.

import { describe, expect, test } from 'bun:test'

import { projectEmployeeCaseNextAction } from '@/modules/digital-employee/application/runtimeService'

describe('digital employee Case next-action projection', () => {
  test('waiting human review belongs to the current user and links the exact execution', () => {
    expect(
      projectEmployeeCaseNextAction({
        caseState: 'active',
        activeRoundExists: true,
        hasPendingInbox: false,
        reviewGates: [
          {
            state: 'waiting',
            executionRef: 'task-awaiting-review',
          },
        ],
      }),
    ).toEqual({
      owner: 'current-user',
      action: 'complete-human-review',
      executionRef: 'task-awaiting-review',
    })
  })

  test('terminal and blocked states keep precedence over a stale review projection', () => {
    const waitingReview = [{ state: 'waiting' as const, executionRef: 'task-review' }]

    expect(
      projectEmployeeCaseNextAction({
        caseState: 'terminal',
        activeRoundExists: false,
        hasPendingInbox: true,
        reviewGates: waitingReview,
      }),
    ).toBeNull()
    expect(
      projectEmployeeCaseNextAction({
        caseState: 'blocked',
        activeRoundExists: false,
        hasPendingInbox: true,
        reviewGates: waitingReview,
      }),
    ).toEqual({ owner: 'current-user', action: 'resolve-blocker' })
  })

  test('platform scheduling and automatic continuation remain the generic fallbacks', () => {
    expect(
      projectEmployeeCaseNextAction({
        caseState: 'active',
        activeRoundExists: false,
        hasPendingInbox: true,
        reviewGates: [],
      }),
    ).toEqual({ owner: 'platform', action: 'schedule-next-reaction' })
    expect(
      projectEmployeeCaseNextAction({
        caseState: 'active',
        activeRoundExists: true,
        hasPendingInbox: true,
        reviewGates: [{ state: 'approved', executionRef: 'task-approved' }],
      }),
    ).toEqual({ owner: 'digital-employee', action: 'continue-automatically' })
  })
})
