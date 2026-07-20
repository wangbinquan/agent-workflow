import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ValidationPanel } from '../src/components/workflow-editor/ValidationPanel'
import i18n from '../src/i18n'

const definition: WorkflowDefinition = {
  $schema_version: 4,
  inputs: [],
  nodes: [{ id: 'worker', kind: 'agent-single', agentName: 'missing' }],
  edges: [],
}

afterEach(() => cleanup())

describe('RFC-199 ValidationPanel navigation surface', () => {
  test('summary opens an anchored details overlay and strict issue button hands off its target', () => {
    const onNavigate = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <div className="canvas-frame">
          <ValidationPanel
            result={{
              ok: false,
              issues: [
                {
                  code: 'agent-not-found',
                  message: 'missing',
                  target: { kind: 'node-field', nodeId: 'worker', field: 'agent' },
                },
              ],
            }}
            stale={null}
            definition={definition}
            onNavigate={onNavigate}
          />
        </div>
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByTestId('workflow-validation-summary'))
    expect(screen.getByTestId('workflow-validation-overlay')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /agent-not-found/i }))
    expect(onNavigate).toHaveBeenCalledWith({
      kind: 'node-field',
      nodeId: 'worker',
      field: 'agent',
    })
    expect(screen.queryByTestId('workflow-validation-overlay')).toBeNull()
  })

  test('a stale strict target never guesses from pointer and offers revalidation', () => {
    const onNavigate = vi.fn()
    const onRevalidate = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ValidationPanel
          result={{
            ok: false,
            issues: [
              {
                code: 'agent-not-found',
                message: 'gone',
                pointer: 'worker',
                target: { kind: 'node', nodeId: 'gone' },
              },
            ],
          }}
          stale={null}
          definition={definition}
          onNavigate={onNavigate}
          onRevalidate={onRevalidate}
        />
      </I18nextProvider>,
    )

    fireEvent.click(screen.getByTestId('workflow-validation-summary'))
    fireEvent.click(screen.getByRole('button', { name: /agent-not-found/i }))
    expect(onNavigate).not.toHaveBeenCalled()
    expect(screen.getAllByText(/object changed|对象已变化/i).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /revalidate|重新校验/i }))
    expect(onRevalidate).toHaveBeenCalledTimes(1)
  })

  test('a stale receipt hides old issues and exposes only the revalidation path', () => {
    const onRevalidate = vi.fn()
    render(
      <I18nextProvider i18n={i18n}>
        <ValidationPanel
          result={{
            ok: false,
            issues: [{ code: 'agent-not-found', message: 'old', pointer: 'worker' }],
          }}
          stale="draft"
          definition={definition}
          onNavigate={vi.fn()}
          onRevalidate={onRevalidate}
        />
      </I18nextProvider>,
    )
    fireEvent.click(screen.getByTestId('workflow-validation-summary'))
    expect(screen.queryByRole('button', { name: /agent-not-found/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /revalidate|重新校验/i }))
    expect(onRevalidate).toHaveBeenCalledTimes(1)
  })
})
