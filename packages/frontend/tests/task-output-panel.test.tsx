// RFC-072 — TaskOutputPanel two-pane UI contract.
//
// Locks: left list of declared output ports, default-selects the first, click
// switches the right detail; Copy goes through copyText; a Download button
// appears only for file-path kinds (path<ext>/markdown_file) with a single-line
// value and calls downloadWorktreeFile(taskId, relPath); pending/empty states.

import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { NodeRun, NodeRunOutput, Task } from '@agent-workflow/shared'

vi.mock('@/lib/worktree-download', () => ({
  downloadWorktreeFile: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }))

import '../src/i18n'
import { TaskOutputPanel } from '../src/components/TaskOutputPanel'
import { copyText } from '@/lib/clipboard'
import { downloadWorktreeFile } from '@/lib/worktree-download'

const snapshot = {
  nodes: [
    {
      id: 'out',
      kind: 'output',
      ports: [
        { name: 'report', bind: { nodeId: 'a', portName: 'doc' } },
        { name: 'summary', bind: { nodeId: 'a', portName: 'sum' } },
        { name: 'waiting', bind: { nodeId: 'b', portName: 'x' } },
      ],
    },
  ],
}

const task = { id: 'task1', workflowSnapshot: snapshot } as unknown as Task
const runs = [{ id: 'run-a', nodeId: 'a', startedAt: 10 }] as unknown as NodeRun[]
const outputs: NodeRunOutput[] = [
  { nodeRunId: 'run-a', port: 'doc', value: 'out/report.md', kind: 'markdown_file' },
  { nodeRunId: 'run-a', port: 'sum', value: 'all good', kind: 'markdown' },
]

function renderPanel() {
  return render(<TaskOutputPanel task={task} runs={runs} outputs={outputs} />)
}

describe('TaskOutputPanel', () => {
  test('lists all declared ports and default-selects the first', () => {
    renderPanel()
    expect(screen.getByTestId('task-output-option-0').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('task-output-option-1').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('task-output-option-2')).toBeTruthy()
    // First port (file kind) value shown in the detail.
    expect(screen.getByText('out/report.md')).toBeTruthy()
  })

  test('file-path kind shows a Download button that calls downloadWorktreeFile', () => {
    renderPanel()
    const dl = screen.getByTestId('task-output-download')
    fireEvent.click(dl)
    expect(vi.mocked(downloadWorktreeFile)).toHaveBeenCalledWith('task1', 'out/report.md')
  })

  test('selecting a text-kind port hides the Download button', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('task-output-option-1'))
    expect(screen.getByText('all good')).toBeTruthy()
    expect(screen.queryByTestId('task-output-download')).toBeNull()
  })

  test('Copy goes through copyText with the selected value', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('task-output-copy'))
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('out/report.md')
  })

  test('pending port (no run) shows pending and disables Copy, no Download', () => {
    renderPanel()
    fireEvent.click(screen.getByTestId('task-output-option-2'))
    expect(screen.getByText('pending…')).toBeTruthy()
    expect((screen.getByTestId('task-output-copy') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('task-output-download')).toBeNull()
  })
})
