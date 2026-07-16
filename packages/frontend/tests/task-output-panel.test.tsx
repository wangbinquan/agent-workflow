// RFC-072 — TaskOutputPanel two-pane UI contract.
//
// Locks: left list of declared output ports, default-selects the first, click
// switches the right detail; Copy goes through copyText; a Download button
// appears only for file-path kinds (path<ext>/markdown_file) with a single-line
// value and calls downloadWorktreeFile(taskId, relPath); pending/empty states.
//
// RFC-105 — adds a "预览" (preview) Link for markdown-renderable ports:
//   - file-kind port whose value is a `.md` path → file-mode preview target
//   - inline `markdown` port → port-mode target (runId+sourcePort)
// The panel now renders a <Link>, so the harness wraps it in a memory router
// (awaited before assertions so the matched route renders synchronously).

import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { NodeRun, NodeRunOutput, Task } from '@agent-workflow/shared'

vi.mock('@/lib/worktree-download', () => ({
  downloadWorktreeFile: vi.fn().mockResolvedValue(undefined),
  downloadPortArtifact: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/clipboard', () => ({ copyText: vi.fn().mockResolvedValue(true) }))

import '../src/i18n'
import { TaskOutputPanel } from '../src/components/TaskOutputPanel'
import { validatePreviewSearch } from '../src/lib/markdown-preview'
import { copyText } from '@/lib/clipboard'
import { downloadPortArtifact, downloadWorktreeFile } from '@/lib/worktree-download'

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

async function renderPanel(props?: { outputs?: NodeRunOutput[] }) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <TaskOutputPanel task={task} runs={runs} outputs={props?.outputs ?? outputs} />
    ),
  })
  const preview = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id/preview',
    validateSearch: (raw: Record<string, unknown>) => validatePreviewSearch(raw),
    component: () => null,
  })
  const taskDetail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, preview, taskDetail]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router as never} />)
}

describe('TaskOutputPanel', () => {
  test('lists all declared ports and default-selects the first', async () => {
    await renderPanel()
    expect(screen.getByRole('tablist').getAttribute('aria-orientation')).toBe('vertical')
    expect(screen.getByTestId('task-output-option-0').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('task-output-option-1').getAttribute('aria-selected')).toBe('false')
    expect(screen.getByTestId('task-output-option-2')).toBeTruthy()
    // First port (file kind) value shown in the detail.
    expect(screen.getByText('out/report.md')).toBeTruthy()
  })

  test('vertical tabs use roving focus, manual activation, and stable panel ids', async () => {
    await renderPanel()
    const tabs = screen.getAllByRole('tab')
    const panels = screen.getAllByRole('tabpanel', { hidden: true })
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1])
    expect(panels).toHaveLength(3)
    for (const [index, tab] of tabs.entries()) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '')
      expect(panel).not.toBeNull()
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id)
      expect((panel as HTMLElement | null)?.hidden).toBe(index !== 0)
    }

    tabs[0]!.focus()
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(tabs[1])
    expect(screen.getByTestId('task-output-option-0').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('out/report.md')).toBeTruthy()

    fireEvent.keyDown(tabs[1]!, { key: 'Enter' })
    expect(screen.getByTestId('task-output-option-1').getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('all good')).toBeTruthy()
  })

  test('vertical tabs support Home/End/Space and ignore modified arrows', async () => {
    await renderPanel()
    const tabs = screen.getAllByRole('tab')

    tabs[0]!.focus()
    fireEvent.keyDown(tabs[0]!, { key: 'End' })
    expect(document.activeElement).toBe(tabs[2])
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, -1, 0])

    fireEvent.keyDown(tabs[2]!, { key: ' ' })
    expect(screen.getByTestId('task-output-option-2').getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(tabs[2]!, { key: 'Home' })
    expect(document.activeElement).toBe(tabs[0])
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowDown', metaKey: true })
    expect(document.activeElement).toBe(tabs[0])
    expect(screen.getByTestId('task-output-option-2').getAttribute('aria-selected')).toBe('true')
  })

  test('file-path kind Download prefers the port-artifact archive (RFC-193)', async () => {
    // sourceRunId 可得（run-a）→ 走归档下载（内部 404 自动回退 worktree）；
    // downloadWorktreeFile 不再被直接调用。
    await renderPanel()
    const dl = screen.getByTestId('task-output-download')
    fireEvent.click(dl)
    expect(vi.mocked(downloadPortArtifact)).toHaveBeenCalledWith(
      'task1',
      'run-a',
      'doc',
      'out/report.md',
    )
    expect(vi.mocked(downloadWorktreeFile)).not.toHaveBeenCalled()
  })

  test('selecting a text-kind port hides the Download button', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('task-output-option-1'))
    expect(screen.getByText('all good')).toBeTruthy()
    expect(screen.queryByTestId('task-output-download')).toBeNull()
  })

  test('Copy goes through copyText with the selected value', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('task-output-copy'))
    expect(vi.mocked(copyText)).toHaveBeenCalledWith('out/report.md')
  })

  test('pending port (no run) shows pending and disables Copy, no Download', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('task-output-option-2'))
    expect(screen.getByText('pending…')).toBeTruthy()
    expect((screen.getByTestId('task-output-copy') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByTestId('task-output-download')).toBeNull()
  })

  // ---- RFC-105 preview button ----

  test('.md file port shows a Preview link targeting file mode', async () => {
    await renderPanel()
    const link = screen.getByTestId('task-output-preview') as HTMLAnchorElement
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('/tasks/task1/preview')
    expect(href).toContain('report.md') // file mode → ?path=out/report.md
  })

  test('inline markdown port shows a Preview link targeting port mode', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('task-output-option-1'))
    const href = (screen.getByTestId('task-output-preview') as HTMLAnchorElement).getAttribute(
      'href',
    )
    expect(href).toContain('/tasks/task1/preview')
    expect(href).toContain('runId=run-a')
    expect(href).toContain('port=sum')
  })

  test('pending port shows no Preview link', async () => {
    await renderPanel()
    fireEvent.click(screen.getByTestId('task-output-option-2'))
    expect(screen.queryByTestId('task-output-preview')).toBeNull()
  })

  test('non-markdown ports (string / non-.md file) show no Preview link', async () => {
    await renderPanel({
      outputs: [
        { nodeRunId: 'run-a', port: 'doc', value: 'diagram.png', kind: 'path<png>' },
        { nodeRunId: 'run-a', port: 'sum', value: 'plain text', kind: 'string' },
      ],
    })
    expect(screen.queryByTestId('task-output-preview')).toBeNull()
    fireEvent.click(screen.getByTestId('task-output-option-1'))
    expect(screen.queryByTestId('task-output-preview')).toBeNull()
  })
})
