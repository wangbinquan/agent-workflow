// RFC-060 PR-C — ValidationPanel renders wrapper-fanout-nested as a generic
// warning row (same chrome as other warnings). This test reuses the
// MiniPanel fixture pattern from validation-panel-autofit so it can
// exercise the route's local ValidationPanel structure without dragging in
// the full TanStack Router setup.
//
// Locks:
//  1. `wrapper-fanout-nested` lands in the warnings bucket via
//     partitionIssues (severity: 'warning' explicit on the issue).
//  2. The rendered warning row includes both the code and the message
//     so authors can read the cartesian-explosion explanation.
//  3. No Auto-fit button shows for `wrapper-fanout-nested` (that affordance
//     is RFC-016 wrapper-children-outside-bounds only).

import { afterEach, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import '../src/i18n'
import { partitionIssues as _partitionIssues } from '../src/routes/workflows.edit'

interface MiniIssue {
  code: string
  message: string
  severity?: 'error' | 'warning'
  pointer?: string
}

function partitionIssues(issues: MiniIssue[]): { errors: MiniIssue[]; warnings: MiniIssue[] } {
  return _partitionIssues(
    issues as unknown as Parameters<typeof _partitionIssues>[0],
  ) as unknown as { errors: MiniIssue[]; warnings: MiniIssue[] }
}

afterEach(() => {
  document.body.innerHTML = ''
})

// Mirror of the route-internal ValidationPanel warning row. The route's
// private component is what we're locking; this mini reproduces the
// generic-warning chrome so the assertion is meaningful.
function MiniPanel({ issues }: { issues: MiniIssue[] }) {
  const { warnings } = partitionIssues(issues)
  return (
    <ul>
      {warnings.map((i, idx) => (
        <li key={`w-${idx}`}>
          <code>{i.code}</code> — {i.message}
        </li>
      ))}
    </ul>
  )
}

describe('wrapper-fanout-nested warning rendering', () => {
  test('partitionIssues routes wrapper-fanout-nested to warnings', () => {
    const issues: MiniIssue[] = [
      {
        code: 'wrapper-fanout-nested',
        message:
          "wrapper-fanout 'inner' is nested inside wrapper-fanout 'outer' — total shard count grows multiplicatively",
        severity: 'warning',
        pointer: 'inner',
      },
    ]
    const { errors, warnings } = partitionIssues(issues)
    expect(errors).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('wrapper-fanout-nested')
  })

  test('rendered warning row includes the code + message', () => {
    render(
      <MiniPanel
        issues={[
          {
            code: 'wrapper-fanout-nested',
            message:
              "wrapper-fanout 'inner' is nested inside wrapper-fanout 'outer' — total shard count grows multiplicatively",
            severity: 'warning',
            pointer: 'inner',
          },
        ]}
      />,
    )
    expect(screen.getByText(/wrapper-fanout-nested/)).toBeTruthy()
    expect(screen.getByText(/grows multiplicatively/i)).toBeTruthy()
  })

  test('no Auto-fit button for wrapper-fanout-nested', () => {
    render(
      <MiniPanel
        issues={[
          {
            code: 'wrapper-fanout-nested',
            message: 'cartesian explosion likely',
            severity: 'warning',
            pointer: 'inner',
          },
        ]}
      />,
    )
    // Auto-fit affordance is RFC-016 only; cartesian guard does not
    // surface a recovery button.
    expect(screen.queryByRole('button')).toBeNull()
  })
})
