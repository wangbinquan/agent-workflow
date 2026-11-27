// RFC-060 PR-C — ValidationPanel renders wrapper-fanout-nested as a generic
// warning row (same chrome as other warnings). RFC-624 shares the real
// ValidationPanel fixture with validation-panel-autofit, without loading the
// route or maintaining another copy of its rendering logic.
//
// Locks:
//  1. `wrapper-fanout-nested` lands in the warnings bucket via
//     partitionIssues (severity: 'warning' explicit on the issue).
//  2. The rendered warning row includes both the code and the message
//     so authors can read the cartesian-explosion explanation.
//  3. No Auto-fit button shows for `wrapper-fanout-nested` (that affordance
//     is RFC-016 wrapper-children-outside-bounds only).

import type { WorkflowValidationIssue } from '@agent-workflow/shared'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { partitionValidationIssues } from '../src/components/workflow-editor/ValidationPanel'
import { renderValidationPanel } from './validation-panel.helpers'

describe('wrapper-fanout-nested warning rendering', () => {
  test('partitionIssues routes wrapper-fanout-nested to warnings', () => {
    const issues: WorkflowValidationIssue[] = [
      {
        code: 'wrapper-fanout-nested',
        message:
          "wrapper-fanout 'inner' is nested inside wrapper-fanout 'outer' — total shard count grows multiplicatively",
        severity: 'warning',
        pointer: 'inner',
      },
    ]
    const { errors, warnings } = partitionValidationIssues(issues)
    expect(errors).toHaveLength(0)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.code).toBe('wrapper-fanout-nested')
  })

  test('rendered warning row includes the code + message', async () => {
    const message =
      "wrapper-fanout 'inner' is nested inside wrapper-fanout 'outer' — total shard count grows multiplicatively"
    await renderValidationPanel([
      { code: 'wrapper-fanout-nested', message, severity: 'warning', pointer: 'inner' },
    ])
    expect(screen.getByRole('button', { name: /wrapper-fanout-nested/ })).toBeTruthy()
    const rawSummary = screen.getByText('Raw error message', { selector: 'summary' })
    fireEvent.click(rawSummary)
    const details = rawSummary.closest('details')!
    expect(details.open).toBe(true)
    expect(within(details).getByText(message, { selector: 'pre' })).toBeTruthy()
  })

  test('no Auto-fit button for wrapper-fanout-nested', async () => {
    await renderValidationPanel(
      [
        {
          code: 'wrapper-fanout-nested',
          message: 'cartesian explosion likely',
          severity: 'warning',
          pointer: 'inner',
        },
      ],
      { onAutoFitWrapper: vi.fn() },
    )
    // Auto-fit affordance is RFC-016 only; cartesian guard does not
    // surface a recovery button even when the target and callback exist.
    expect(screen.getByRole('button', { name: /wrapper-fanout-nested/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Auto-fit' })).toBeNull()
  })
})
