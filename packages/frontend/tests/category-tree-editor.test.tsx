// RFC-372: user-authored subcategories must survive edit/save/undo as full paths.
import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { WorkflowNodeSchema, type WorkflowNode } from '@agent-workflow/shared'
import { CategoryTreeEditor, type CategoryTreeLabels } from '../src/components/CategoryTreeEditor'
import { ClarifyModeEdit } from '../src/components/canvas/inspector/ClarifyModeEdit'

const labels: CategoryTreeLabels = {
  addRoot: 'Add root',
  addChild: 'Add child',
  rename: 'Rename',
  remove: 'Delete',
  removeBranch: 'Delete branch',
  name: 'Name',
  save: 'Save',
  cancel: 'Cancel',
  empty: 'AI organizes questions',
  duplicate: 'Duplicate sibling',
  required: 'Name required',
  limit: 'Limit exceeded',
  changed: 'Selection changed',
  expand: 'Expand',
  collapse: 'Collapse',
}
function Harness({
  initial = [],
  onChange = () => {},
  maxNodes = 40,
}: {
  initial?: string[][]
  onChange?(paths: string[][]): void
  maxNodes?: number
}) {
  const [paths, setPaths] = useState(initial)
  return (
    <CategoryTreeEditor
      value={paths}
      onChange={(next) => {
        setPaths(next)
        onChange(next)
      }}
      labels={labels}
      ariaLabel="Categories"
      maxNodes={maxNodes}
      maxNameLength={120}
    />
  )
}
const button = (name: string) => screen.getByRole('button', { name })
const row = (name: string) => screen.getByRole('treeitem', { name })
function commitName(name: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: name } })
  fireEvent.click(button('Save'))
}

test('creates three levels, renames the complete subtree and cancels without changing persisted paths', () => {
  const changed = vi.fn()
  render(<Harness onChange={changed} />)
  fireEvent.click(button('Add root'))
  commitName('Performance')
  fireEvent.click(button('Add child'))
  commitName('Database')
  fireEvent.click(button('Add child'))
  commitName('SQL')
  expect(row('SQL').getAttribute('aria-level')).toBe('3')
  expect(changed).toHaveBeenLastCalledWith([
    ['Performance'],
    ['Performance', 'Database'],
    ['Performance', 'Database', 'SQL'],
  ])
  fireEvent.click(row('Database'))
  fireEvent.click(button('Rename'))
  commitName('Storage')
  expect(changed).toHaveBeenLastCalledWith([
    ['Performance'],
    ['Performance', 'Storage'],
    ['Performance', 'Storage', 'SQL'],
  ])
  fireEvent.click(button('Add child'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), {
    target: { value: 'Uncommitted' },
  })
  fireEvent.click(button('Cancel'))
  expect(changed).toHaveBeenCalledTimes(4)
  expect(screen.queryByRole('treeitem', { name: 'Uncommitted' })).toBeNull()
  expect(document.activeElement).toBe(row('Storage'))
  fireEvent.click(button('Delete branch'))
  expect(changed).toHaveBeenLastCalledWith([['Performance']])
  expect(document.activeElement).toBe(row('Performance'))
  fireEvent.click(button('Delete'))
  expect(document.activeElement).toBe(button('Add root'))
  expect(screen.getByText('AI organizes questions')).toBeTruthy()
})

test('same-parent duplicates and empty names are rejected; different parents can share a child name', () => {
  const changed = vi.fn()
  render(
    <Harness
      initial={[
        ['Performance', 'Database'],
        ['Reliability', 'Database'],
      ]}
      onChange={changed}
    />,
  )
  expect(screen.getAllByRole('treeitem', { name: 'Database' })).toHaveLength(2)
  fireEvent.click(row('Performance'))
  fireEvent.click(button('Add child'))
  commitName(' Database ')
  expect(screen.getByText('Duplicate sibling')).toBeTruthy()
  commitName(' ')
  expect(screen.getByText('Name required')).toBeTruthy()
  expect(changed).not.toHaveBeenCalled()
  fireEvent.click(button('Cancel'))
  fireEvent.click(row('Reliability'))
  fireEvent.click(button('Add child'))
  commitName('SQL')
  expect(changed.mock.calls.at(-1)?.[0]).toContainEqual(['Reliability', 'SQL'])
})

test('tree keys preserve roving focus across expand/collapse and every prefix counts toward the limit', () => {
  render(<Harness initial={[['Performance', 'Database', 'SQL'], ['Reliability']]} maxNodes={4} />)
  expect(button('Add root').hasAttribute('disabled')).toBe(true)
  expect(button('Add child').hasAttribute('disabled')).toBe(true)
  fireEvent.click(button('Collapse Performance'))
  expect(document.activeElement).toBe(row('Performance'))
  expect(screen.queryByRole('treeitem', { name: 'SQL' })).toBeNull()
  fireEvent.keyDown(row('Performance'), { key: 'ArrowRight' })
  expect(row('SQL').getAttribute('aria-level')).toBe('3')
  fireEvent.keyDown(row('Performance'), { key: 'ArrowRight' })
  expect(document.activeElement).toBe(row('Database'))
  fireEvent.keyDown(row('Database'), { key: 'End' })
  expect(document.activeElement).toBe(row('Reliability'))
  expect(screen.getAllByRole('treeitem').filter((item) => item.tabIndex === 0)).toEqual([
    row('Reliability'),
  ])
  fireEvent.keyDown(row('Reliability'), { key: 'F2' })
  expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe(
    'Reliability',
  )
})

test('inspector saves nested paths as one atomic edit, preserves legacy slash names and focus notes, and reopens them after undo', () => {
  const patch = vi.fn()
  const original = WorkflowNodeSchema.parse({
    id: 'gate',
    kind: 'clarify',
    interactionMode: 'mindmap',
    mindmap: { categories: ['Service/API'], instructions: 'Keep my business focus' },
  })
  function Inspector() {
    const [node, setNode] = useState<WorkflowNode>(original)
    return (
      <>
        <button onClick={() => setNode(original)}>Undo fixture</button>
        <ClarifyModeEdit
          node={node}
          onHistoryBoundary={() => {}}
          onPatch={(next, meta) => {
            patch(next, meta)
            setNode(next)
          }}
        />
      </>
    )
  }
  render(<Inspector />)
  fireEvent.click(button('Add subcategory'))
  fireEvent.change(screen.getByRole('textbox', { name: 'Category name' }), {
    target: { value: 'Database' },
  })
  fireEvent.click(button('Save category'))
  const [next, meta] = patch.mock.calls[0]!
  expect(WorkflowNodeSchema.parse(JSON.parse(JSON.stringify(next))).mindmap).toEqual({
    categories: [['Service/API'], ['Service/API', 'Database']],
    instructions: 'Keep my business focus',
  })
  expect(meta).toMatchObject({ source: 'inspector', transaction: 'single' })
  expect(
    (screen.getByRole('textbox', { name: 'Additional focus (optional)' }) as HTMLTextAreaElement)
      .value,
  ).toBe('Keep my business focus')
  fireEvent.click(button('Undo fixture'))
  expect(screen.queryByRole('treeitem', { name: 'Database' })).toBeNull()
  expect(row('Service/API').getAttribute('aria-level')).toBe('1')
})
