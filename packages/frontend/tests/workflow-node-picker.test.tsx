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

function manyAgents(count: number): Agent[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `agent-${index}`,
    name: `agent-${String(index).padStart(2, '0')}`,
    description: index === count - 1 ? 'Audits security boundaries' : `Capability ${index}`,
    outputs: ['out'],
  })) as Agent[]
}

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
  test('uses shared search/category primitives and exposes stable counts plus discovery groups', () => {
    localStorage.setItem(NODE_PICKER_RECENT_STORAGE_KEY, JSON.stringify(['agent:agent-a']))
    const { getByRole, getByTestId, getAllByText } = renderPicker()
    const search = getByTestId('workflow-node-picker-search')
    expect(search.getAttribute('type')).toBe('search')
    expect(search.getAttribute('aria-label')).not.toBeNull()
    expect(getByRole('tablist', { name: /node type|节点类型/ })).toBeTruthy()
    expect(getByTestId('workflow-node-picker-category-all').textContent).toMatch(/9/)
    expect(getByTestId('workflow-node-picker-category-agents').textContent).toMatch(/1/)
    expect(getByTestId('workflow-node-picker-category-wrappers').textContent).toMatch(/3/)
    expect(getByTestId('workflow-node-picker-category-io').textContent).toMatch(/2/)
    expect(getByTestId('workflow-node-picker-category-human').textContent).toMatch(/3/)
    expect(getAllByText(/Recommended|推荐/).length).toBeGreaterThan(0)
    expect(getAllByText(/Recent|最近/).length).toBeGreaterThan(0)
    expect(getAllByText(/Agents|代理/).length).toBeGreaterThan(0)
    expect(getAllByText(/Wrappers|包装器/).length).toBeGreaterThan(0)
  })

  test('50 Agents cannot bury Wrapper or Human rows behind the Agent catalog', () => {
    const { getByTestId, queryAllByTestId } = renderPicker({ agents: manyAgents(50) })
    expect(getByTestId('workflow-node-picker-category-agents').textContent).toContain('50')

    fireEvent.click(getByTestId('workflow-node-picker-category-wrappers'))
    expect(queryAllByTestId(/^workflow-node-picker-item-agent-/)).toHaveLength(0)
    expect(queryAllByTestId(/^workflow-node-picker-item-kind-wrapper-/)).toHaveLength(3)

    fireEvent.click(getByTestId('workflow-node-picker-category-human'))
    expect(queryAllByTestId(/^workflow-node-picker-item-agent-/)).toHaveLength(0)
    expect(queryAllByTestId(/^workflow-node-picker-item-kind-(review|clarify)/)).toHaveLength(3)
  })

  test('category tabs own uniquely linked panels and support automatic arrow-key activation', () => {
    const { getByTestId } = renderPicker()
    const allTab = getByTestId('workflow-node-picker-category-all')
    const allPanelId = allTab.getAttribute('aria-controls')
    expect(allPanelId).not.toBeNull()
    const allPanel = document.getElementById(allPanelId ?? '')
    expect(allPanel?.getAttribute('aria-labelledby')).toBe(allTab.id)
    expect(allPanel?.hidden).toBe(false)

    allTab.focus()
    fireEvent.keyDown(allTab, { key: 'ArrowRight' })
    const agentsTab = getByTestId('workflow-node-picker-category-agents')
    expect(document.activeElement).toBe(agentsTab)
    expect(agentsTab.getAttribute('aria-selected')).toBe('true')
    expect(allPanel?.hidden).toBe(true)
    const agentPanel = document.getElementById(agentsTab.getAttribute('aria-controls') ?? '')
    expect(agentPanel?.hidden).toBe(false)
  })

  test('category and search compose without clearing the query', () => {
    const { getByTestId, queryAllByTestId } = renderPicker({ agents: manyAgents(5) })
    const search = getByTestId('workflow-node-picker-search')
    fireEvent.change(search, { target: { value: 'security' } })
    expect(queryAllByTestId(/^workflow-node-picker-item-agent-/)).toHaveLength(1)

    fireEvent.click(getByTestId('workflow-node-picker-category-wrappers'))
    expect((search as HTMLInputElement).value).toBe('security')
    expect(queryAllByTestId(/^workflow-node-picker-item-/)).toHaveLength(0)

    fireEvent.click(getByTestId('workflow-node-picker-category-agents'))
    expect((search as HTMLInputElement).value).toBe('security')
    expect(queryAllByTestId(/^workflow-node-picker-item-agent-/)).toHaveLength(1)
  })

  test('every mixed discovery row carries a visible non-color category label', () => {
    const { getAllByTestId } = renderPicker()
    const agentRow = getAllByTestId('workflow-node-picker-item-agent-agent-a')[0]!
    const reviewRow = getAllByTestId('workflow-node-picker-item-kind-review')[0]!
    expect(agentRow.dataset.category).toBe('agents')
    expect(agentRow.querySelector('.workflow-node-picker__type-chip')?.textContent).toMatch(/Agent/)
    expect(reviewRow.dataset.category).toBe('human')
    expect(reviewRow.querySelector('.workflow-node-picker__type-chip')?.textContent).toMatch(
      /Human|人工/,
    )
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

  test('same-name agents expose id-keyed rows and recent selection', () => {
    const onPick = vi.fn()
    const duplicateNameAgents = [
      { ...agents[0]!, id: 'agent-owner-a', ownerUserId: null },
      { ...agents[0]!, id: 'agent-owner-b', ownerUserId: null },
    ] as Agent[]
    const { getAllByTestId } = renderPicker({ agents: duplicateNameAgents, onPick })

    expect(getAllByTestId('workflow-node-picker-item-agent-agent-owner-a').length).toBeGreaterThan(
      0,
    )
    const right = getAllByTestId('workflow-node-picker-item-agent-agent-owner-b')[0]!
    fireEvent.click(right)

    expect(onPick).toHaveBeenCalledWith({
      kind: 'agent-single',
      agentName: 'builder',
      agentId: 'agent-owner-b',
    })
    expect(JSON.parse(localStorage.getItem(NODE_PICKER_RECENT_STORAGE_KEY) ?? '[]')).toEqual([
      'agent:agent-owner-b',
    ])
  })

  test('search ArrowDown only enters the active category panel', async () => {
    const { getByTestId } = renderPicker()
    fireEvent.click(getByTestId('workflow-node-picker-category-human'))
    const search = getByTestId('workflow-node-picker-search')
    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    const active = document.activeElement as HTMLElement
    expect(active.dataset.category).toBe('human')
  })

  test('zero-Agent category remains selectable and explains the empty result', () => {
    const { getByTestId, getByText, queryAllByTestId } = renderPicker({ agents: [] })
    expect(getByTestId('workflow-node-picker-category-agents').textContent).toContain('0')
    fireEvent.click(getByTestId('workflow-node-picker-category-agents'))
    expect(queryAllByTestId(/^workflow-node-picker-item-/)).toHaveLength(0)
    expect(getByText(/No matching steps|没有匹配的步骤/)).toBeTruthy()
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
