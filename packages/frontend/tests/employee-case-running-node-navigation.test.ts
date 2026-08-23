// User regression 2026-08-23: the responsibility map already showed a live
// round as running, but selecting that node only opened its frozen contract.
// The same click must enter the TaskEngine execution that owns the live round.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

import { runningRoundTaskTarget } from '../src/routes/employee-cases.$caseId'

describe('digital employee running-node navigation', () => {
  test.each(['planned', 'running', 'settling'])(
    'the UI-running %s state targets its workflow task',
    (state) => {
      expect(runningRoundTaskTarget({ state, executionRef: 'task-live' })).toEqual({
        to: '/tasks/$id',
        params: { id: 'task-live' },
      })
    },
  )

  test.each(['completed', 'failed', 'obsolete', 'waiting'])(
    'the non-running %s state keeps the click on the Case page',
    (state) => {
      expect(runningRoundTaskTarget({ state, executionRef: 'task-terminal' })).toBeNull()
    },
  )

  test('a visually running round without an execution never creates a dead link', () => {
    expect(runningRoundTaskTarget({ state: 'running', executionRef: null })).toBeNull()
    expect(runningRoundTaskTarget(undefined)).toBeNull()
  })

  test('both responsibility nodes and deterministic dispatch nodes use the same target oracle', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'src', 'routes', 'employee-cases.$caseId.tsx'),
      'utf8',
    )
    const responsibilityClick = source.slice(
      source.indexOf('onSelect={(workItemRef)'),
      source.indexOf('onSelectReviewGate='),
    )
    const dispatchClick = source.slice(
      source.indexOf('onSelectDispatchNode={(node)'),
      source.indexOf('toolState={runtimeToolState}'),
    )

    expect(responsibilityClick).toMatch(
      /runningRoundTaskTarget\(\s*latestRoundByWorkItem\.get\(workItemRef\),?\s*\)/,
    )
    expect(responsibilityClick).toContain('void navigate(target)')
    expect(dispatchClick).toContain('runningRoundTaskTarget(latest)')
    expect(dispatchClick).toContain('void navigate(target)')
  })
})
