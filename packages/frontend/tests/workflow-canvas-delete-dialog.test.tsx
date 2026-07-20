// RFC-198 — the wrapper+children destructive action must be an in-app,
// snapshot-fenced confirmation. The context-menu trigger unmounts, so closing
// must restore focus to the stable canvas root.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { WorkflowCanvas } from '../src/components/canvas/WorkflowCanvas'
import i18n from '../src/i18n'

function wrapper(id: string, childIds: string[]): WorkflowNode {
  return {
    id,
    kind: 'wrapper-git',
    nodeIds: childIds,
    position: { x: 20, y: 20 },
  } as unknown as WorkflowNode
}

function agent(id: string, x = 80): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentName: 'coder',
    position: { x, y: 80 },
  } as unknown as WorkflowNode
}

function definition(childIds = ['a1']): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [wrapper('w1', childIds), ...childIds.map((id, index) => agent(id, 80 + index * 80))],
    edges: [],
  }
}

function renderCanvas(initial: WorkflowDefinition, onChange = vi.fn()) {
  const view = render(
    <I18nextProvider i18n={i18n}>
      <WorkflowCanvas surface="editor" definition={initial} onChange={onChange} />
    </I18nextProvider>,
  )
  return { onChange, ...view }
}

async function openDeleteDialog(container: HTMLElement) {
  const wrapperNode = await waitFor(() => {
    const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="w1"]')
    expect(node).not.toBeNull()
    return node!
  })
  fireEvent.contextMenu(wrapperNode, { clientX: 40, clientY: 40 })
  fireEvent.click(
    await screen.findByRole('menuitem', { name: /Delete wrapper and inner nodes|连同内部节点/i }),
  )
  return screen.findByRole('dialog', {
    name: /Delete wrapper and inner nodes|连同内部节点/i,
  })
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WorkflowCanvas wrapper delete confirmation', () => {
  test('confirmed unchanged snapshot deletes once and restores canvas focus', async () => {
    const { container, onChange } = renderCanvas(definition())
    const dialog = await openDeleteDialog(container)
    expect(dialog.textContent).toMatch(/1 inner node|1 个内部节点/i)

    const confirm = within(dialog).getByRole('button', { name: /^Delete$|^删除$/i })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const next = onChange.mock.calls[0]?.[0] as WorkflowDefinition
    expect(next.nodes).toEqual([])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(container.querySelector('.workflow-canvas'))
  })

  test('cancel restores focus to the canvas when the context-menu trigger is gone', async () => {
    const { container, onChange } = renderCanvas(definition())
    const dialog = await openDeleteDialog(container)

    fireEvent.click(within(dialog).getByRole('button', { name: /^Cancel$|^取消$/i }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(onChange).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(container.querySelector('.workflow-canvas'))
  })

  test('changed child set rejects inside the dialog without deleting stale scope', async () => {
    const onChange = vi.fn()
    const first = definition()
    const { container, rerender } = renderCanvas(first, onChange)
    const dialog = await openDeleteDialog(container)

    rerender(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          surface="editor"
          definition={definition(['a1', 'a2'])}
          onChange={onChange}
        />
      </I18nextProvider>,
    )
    fireEvent.click(within(dialog).getByRole('button', { name: /^Delete$|^删除$/i }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toMatch(/latest canvas|最新画布/i)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})
