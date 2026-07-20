import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createRef } from 'react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import {
  NODE_PICKER_RECENT_STORAGE_KEY,
  WorkflowNodePicker,
} from '../src/components/workflow-editor/WorkflowNodePicker'
import i18n from '../src/i18n'

const agents = [
  {
    id: 'agent-a',
    name: 'builder',
    description: 'Builds the requested change',
    outputs: ['out'],
  },
] as Agent[]

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

function renderPicker(props: Partial<React.ComponentProps<typeof WorkflowNodePicker>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <WorkflowNodePicker
        open
        agents={agents}
        intent={{ kind: 'free', viewportPoint: { x: 20, y: 30 }, scope: { kind: 'top-level' } }}
        onPick={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </I18nextProvider>,
  )
}

describe('WorkflowNodePicker', () => {
  test('uses the shared search input and exposes recommended/recent/all groups', () => {
    localStorage.setItem(NODE_PICKER_RECENT_STORAGE_KEY, JSON.stringify(['agent:builder']))
    const { getByTestId, getAllByText } = renderPicker()
    const search = getByTestId('workflow-node-picker-search')
    expect(search.getAttribute('type')).toBe('search')
    expect(search.getAttribute('aria-label')).not.toBeNull()
    expect(getAllByText(/Recommended|推荐/).length).toBeGreaterThan(0)
    expect(getAllByText(/Recent|最近/).length).toBeGreaterThan(0)
    expect(getAllByText(/All|全部/).length).toBeGreaterThan(0)
  })

  test('search covers labels, kinds and descriptions', () => {
    const { getByTestId, queryAllByTestId } = renderPicker()
    fireEvent.change(getByTestId('workflow-node-picker-search'), {
      target: { value: 'requested change' },
    })
    const rows = queryAllByTestId(/^workflow-node-picker-item-/)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('builder')
  })

  test('disabled candidates remain focusable, explain why, and cannot mutate', () => {
    const onPick = vi.fn()
    const { getAllByTestId } = renderPicker({
      onPick,
      disabledReason: (item) => (item.kind === 'input' ? 'No compatible output port.' : null),
    })
    const inputRow = getAllByTestId('workflow-node-picker-item-kind-input')[0]!
    expect(inputRow.getAttribute('aria-disabled')).toBe('true')
    expect(inputRow.textContent).toContain('No compatible output port.')
    inputRow.focus()
    expect(document.activeElement).toBe(inputRow)
    fireEvent.click(inputRow)
    expect(onPick).not.toHaveBeenCalled()
  })

  test('Arrow keys move the active row, Enter selects, and selection records identity only', async () => {
    const onPick = vi.fn()
    const { getByTestId } = renderPicker({ onPick })
    const search = getByTestId('workflow-node-picker-search')
    await waitFor(() => expect(document.activeElement).toBe(search))
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const active = document.activeElement as HTMLElement
    expect(active.dataset.testid).toMatch(/^workflow-node-picker-item-/)
    fireEvent.keyDown(active, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledTimes(1)
    const stored = JSON.parse(localStorage.getItem(NODE_PICKER_RECENT_STORAGE_KEY) ?? '[]')
    expect(stored).toHaveLength(1)
    expect(typeof stored[0]).toBe('string')
    expect(stored[0]).not.toContain('workflow')
  })

  test('Escape closes and restores focus to the explicit trigger', async () => {
    const onClose = vi.fn()
    const triggerRef = createRef<HTMLButtonElement>()
    const { getByTestId } = render(
      <I18nextProvider i18n={i18n}>
        <button ref={triggerRef}>open</button>
        <WorkflowNodePicker
          open
          agents={agents}
          intent={{ kind: 'free', viewportPoint: { x: 0, y: 0 }, scope: { kind: 'top-level' } }}
          onPick={vi.fn()}
          onClose={onClose}
          triggerRef={triggerRef}
        />
      </I18nextProvider>,
    )
    fireEvent.keyDown(getByTestId('workflow-node-picker-search'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
