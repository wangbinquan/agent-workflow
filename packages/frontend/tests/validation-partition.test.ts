// RFC-004 — ValidationPanel partitions issues by severity. Errors block task
// launch (validation-panel--bad style); warnings are informational
// (validation-panel--warn). If this goes red, check partitionIssues +
// ValidationPanel in workflows.edit.tsx AND the severity field in the
// shared WorkflowValidationIssueSchema.

import { describe, expect, test } from 'vitest'
import { partitionIssues } from '../src/routes/workflows.edit'

describe('partitionIssues', () => {
  test('treats missing severity as error (backwards compatibility)', () => {
    const { errors, warnings } = partitionIssues([
      { code: 'a', message: 'A' },
      { code: 'b', message: 'B', severity: 'error' },
    ])
    expect(errors).toHaveLength(2)
    expect(warnings).toHaveLength(0)
  })

  test('groups warnings into their own bucket', () => {
    const { errors, warnings } = partitionIssues([
      { code: 'orphan', message: 'orphan', severity: 'warning' },
      { code: 'bad', message: 'bad' },
    ])
    expect(errors.map((i) => i.code)).toEqual(['bad'])
    expect(warnings.map((i) => i.code)).toEqual(['orphan'])
  })

  test('all-warnings case yields zero errors (panel must still show ok-style)', () => {
    const { errors, warnings } = partitionIssues([
      { code: 'input-orphan-declared', message: '...', severity: 'warning' },
    ])
    expect(errors).toEqual([])
    expect(warnings).toHaveLength(1)
  })
})
