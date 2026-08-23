// User regression 2026-08-23: an active Case at a waiting human-review gate
// told the user that no action was needed. The domain projection now owns the
// decision; this test locks the Case-specific copy and direct review-session CTA.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { nextActionCopy, type EmployeeCaseProjection } from '../src/routes/employee-cases.$caseId'

function projection(nextAction: EmployeeCaseProjection['nextAction']): EmployeeCaseProjection {
  return {
    case: {
      state: 'active',
      terminalKind: null,
      blockReason: null,
    },
    attention: [],
    nextAction,
  } as unknown as EmployeeCaseProjection
}

describe('digital employee Case next action', () => {
  test('human review copy never claims that work continues automatically', () => {
    const next = projection({
      owner: 'current-user',
      action: 'complete-human-review',
      executionRef: 'task-awaiting-review',
    })

    expect(nextActionCopy(next, true)).toEqual({
      tone: 'warning',
      title: '下一步：完成人工评审',
      body: '打开待评审的执行 Session，提交评审决定后数字员工会自动继续。',
    })
    expect(nextActionCopy(next, false).title).toBe('Next: complete the human review')
  })

  test('the Case notice links directly to the execution named by the domain projection', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'employee-cases.$caseId.tsx'),
      'utf8',
    )

    expect(source).toContain("data.nextAction?.action === 'complete-human-review'")
    expect(source).toContain('params={{ id: data.nextAction.executionRef }}')
    expect(source).toContain("zh ? '继续人工评审' : 'Continue human review'")
  })
})
