// RFC-624: share preparation, not a second implementation of ValidationPanel.
// Every call creates fresh workflow data, callbacks, and a real mounted panel.
import type { WorkflowDefinition, WorkflowValidationIssue } from '@agent-workflow/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { vi } from 'vitest'

import { ValidationPanel } from '../src/components/workflow-editor/ValidationPanel'
import i18n from '../src/i18n'

export async function renderValidationPanel(
  issues: readonly WorkflowValidationIssue[],
  options: { onAutoFitWrapper?: (wrapperId: string) => void } = {},
) {
  await i18n.changeLanguage('en-US')
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'k1', label: 'Unused input', required: false }],
    nodes: [
      { id: 'w1', kind: 'wrapper-loop', nodeIds: ['a1'] },
      { id: 'a1', kind: 'agent-single', agentName: 'fixture-agent' },
      { id: 'outer', kind: 'wrapper-fanout', nodeIds: ['inner'], shardSourcePort: 'items' },
      { id: 'inner', kind: 'wrapper-fanout', nodeIds: [], shardSourcePort: 'items' },
    ],
    edges: [],
  }
  const onNavigate = vi.fn()
  const rendered = render(
    <I18nextProvider i18n={i18n}>
      <div className="canvas-frame">
        <ValidationPanel
          result={{ ok: true, issues }}
          stale={null}
          definition={definition}
          onNavigate={onNavigate}
          onAutoFitWrapper={options.onAutoFitWrapper}
        />
      </div>
    </I18nextProvider>,
  )
  fireEvent.click(screen.getByTestId('workflow-validation-summary'))
  return { ...rendered, onNavigate }
}
