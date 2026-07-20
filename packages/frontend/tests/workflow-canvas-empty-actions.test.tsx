import { cleanup, fireEvent, render } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { WorkflowCanvas } from '../src/components/canvas/WorkflowCanvas'
import i18n from '../src/i18n'

const empty: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes: [], edges: [] }

afterEach(() => cleanup())

describe('WorkflowCanvas empty creation state', () => {
  test('editable canvas exposes add-first and starter actions; add opens the shared picker', () => {
    const onStartFromTemplate = vi.fn()
    const { getByTestId, queryByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          surface="editor"
          definition={empty}
          agents={[]}
          onChange={vi.fn()}
          onStartFromTemplate={onStartFromTemplate}
        />
      </I18nextProvider>,
    )
    expect(getByTestId('workflow-canvas-empty')).not.toBeNull()
    fireEvent.click(getByTestId('workflow-empty-add-first'))
    expect(queryByTestId('workflow-node-picker-dialog')).not.toBeNull()
    fireEvent.click(getByTestId('workflow-empty-start-template'))
    expect(onStartFromTemplate).toHaveBeenCalledTimes(1)
  })

  test('read-only empty canvas has no creation CTA', () => {
    const { queryByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas surface="task" definition={empty} readOnly />
      </I18nextProvider>,
    )
    expect(queryByTestId('workflow-empty-add-first')).toBeNull()
    expect(queryByTestId('workflow-empty-start-template')).toBeNull()
  })
})
