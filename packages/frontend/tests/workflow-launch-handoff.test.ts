import { describe, expect, test } from 'vitest'
import { workflowLaunchWizardSearch } from '@/lib/workflow-launch-handoff'

describe('workflow launch exact revision handoff', () => {
  test.each([4, '4'] as const)('carries positive version %s to the task wizard', (version) => {
    expect(workflowLaunchWizardSearch('wf-1', { version })).toEqual({
      kind: 'workflow',
      workflow: 'wf-1',
      workflowVersion: 4,
    })
  })

  test.each([undefined, '', '1.5', 0, -1, Number.NaN])(
    'keeps old bookmarks but drops invalid version %s',
    (version) => {
      expect(workflowLaunchWizardSearch('wf-1', { version })).toEqual({
        kind: 'workflow',
        workflow: 'wf-1',
      })
    },
  )

  test('scheduled-edit legacy search takes precedence over an immediate version', () => {
    expect(workflowLaunchWizardSearch('wf-1', { editScheduled: 'schedule-1', version: 9 })).toEqual(
      { editScheduled: 'schedule-1' },
    )
  })
})
