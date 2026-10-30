// Locks in the 2026-10-30 node picker fix: whatever the user had typed into
// the picker's search vanished when the agent list changed under it. The
// canvas hands the picker `agents ?? []` until the list loads, and refetches
// replace the array. Two separate causes, each locked below:
// - the catalog body cleared its query on every new `agents` array (there
//   since the picker landed with RFC-199, 21c2ab8ac);
// - when owned agents arrived, WorkflowNodePickerCatalog switched to its
//   owner-aware wrapper (f4b7e3527, 2026-07-23) and React remounted the whole
//   body, taking the focus with it.
// CI run 41009133333 (WF-24 retry, Windows) showed it: the cleared search
// brought the "Recommended" group back and the agent's row matched twice.

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import { WorkflowNodePicker } from '../src/components/workflow-editor/WorkflowNodePicker'
import i18n from '../src/i18n'

// The real lookup needs the query client and the signed-in actor; the remount
// depends on neither, so the lookup answers from a fixed table.
vi.mock('../src/hooks/useUserLookup', () => ({
  useUserLookup: () => ({
    get: (id: string | null | undefined) =>
      id === 'user-ada' ? { id, displayName: 'Ada' } : undefined,
    isLoading: false,
    isSuccess: true,
    isError: false,
  }),
}))

const ownedAgents = [
  {
    id: 'agent-alpha',
    name: 'alpha-auditor',
    description: 'Audits the change',
    outputs: ['answer'],
    ownerUserId: 'user-ada',
  },
  {
    id: 'agent-beta',
    name: 'beta-builder',
    description: 'Builds the change',
    outputs: ['out'],
    ownerUserId: 'user-ada',
  },
] as Agent[]

const ownerlessAgents = ownedAgents.map((agent) => ({ ...agent, ownerUserId: null })) as Agent[]

beforeEach(() => localStorage.clear())
afterEach(() => cleanup())

function picker(agents: Agent[]) {
  return (
    <I18nextProvider i18n={i18n}>
      <WorkflowNodePicker
        open
        agents={agents}
        intent={{ kind: 'free', viewportPoint: { x: 0, y: 0 }, scope: { kind: 'top-level' } }}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />
    </I18nextProvider>
  )
}

function typeIntoSearch(view: ReturnType<typeof render>, text: string): HTMLInputElement {
  const search = view.getByTestId('workflow-node-picker-search') as HTMLInputElement
  search.focus()
  fireEvent.change(search, { target: { value: text } })
  return search
}

describe('node picker keeps what the user typed when the agent list arrives late', () => {
  test('owned agents landing after the user typed keep the search box, its text, its focus and the filter', () => {
    const view = render(picker([]))
    const search = typeIntoSearch(view, 'alpha')

    view.rerender(picker(ownedAgents))

    expect(
      view.getByTestId('workflow-node-picker-search'),
      'the search box was rebuilt, so the typed text is gone',
    ).toBe(search)
    expect(search.value).toBe('alpha')
    expect(document.activeElement).toBe(search)
    // With the filter intact only the Agents group lists the match; a cleared
    // filter brings back "Recommended" and the row appears twice.
    expect(view.getAllByTestId('workflow-node-picker-item-agent-agent-alpha')).toHaveLength(1)
    expect(view.queryByTestId('workflow-node-picker-item-agent-agent-beta')).toBeNull()
  })

  test('a refetch that replaces the agent array keeps the filter', () => {
    const view = render(picker(ownedAgents))
    const search = typeIntoSearch(view, 'alpha')

    view.rerender(picker(ownedAgents.map((agent) => ({ ...agent }))))

    expect(search.value).toBe('alpha')
    expect(view.getAllByTestId('workflow-node-picker-item-agent-agent-alpha')).toHaveLength(1)
  })

  test('agents losing their owners on a refetch keep the search box too', () => {
    const view = render(picker(ownedAgents))
    const search = typeIntoSearch(view, 'beta')

    view.rerender(picker(ownerlessAgents))

    expect(view.getByTestId('workflow-node-picker-search')).toBe(search)
    expect(search.value).toBe('beta')
    expect(view.getAllByTestId('workflow-node-picker-item-agent-agent-beta')).toHaveLength(1)
  })

  test('owner names still label the agents once the list arrives', async () => {
    const view = render(picker([]))

    view.rerender(picker(ownedAgents))

    await waitFor(() => {
      const rows = view.getAllByTestId('workflow-node-picker-item-agent-agent-alpha')
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row.textContent).toContain('alpha-auditor · Ada')
    })
  })
})
