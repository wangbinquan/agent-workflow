// RFC-267 — script bodies can escape the 360–420px inspector without
// creating a second draft/save model. These tests lock the full-screen Dialog,
// the shared controlled buffer, permission parity and focus restoration.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { ScriptEdit } from '../src/components/canvas/inspector/ScriptEdit'
import { NodeInspector, type InspectorChangeMeta } from '../src/components/canvas/NodeInspector'
import { clearToken, setToken } from '../src/stores/auth'

const permissionState = vi.hoisted(() => ({ canAuthor: true, isError: false }))
vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    isError: permissionState.isError,
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
      source: 'session',
      permissions: permissionState.canAuthor ? ['scripts:author'] : [],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => !permissionState.isError && permissionState.canAuthor,
  meQueryOptions: (token: string | null) => ({
    queryKey: ['auth', 'me', token ?? 'no-token'] as const,
  }),
}))

const onPatch = vi.fn<(node: WorkflowNode, meta: InspectorChangeMeta) => void>()

beforeEach(async () => {
  setToken('script-fullscreen-test-token')
  permissionState.canAuthor = true
  permissionState.isError = false
  onPatch.mockClear()
  await i18n.changeLanguage('zh-CN')
})

afterEach(() => clearToken())

function scriptNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 's1',
    kind: 'script',
    position: { x: 0, y: 0 },
    language: 'python',
    script: 'print("inline")',
    ...extra,
  } as unknown as WorkflowNode
}

function Harness({ initialNode }: { initialNode: WorkflowNode }) {
  const [node, setNode] = useState(initialNode)
  const definition = {
    $schema_version: 4,
    inputs: [],
    nodes: [node],
    edges: [],
  } as unknown as WorkflowDefinition
  return (
    <ScriptEdit
      node={node}
      agents={[] as Agent[]}
      definition={definition}
      onPatch={(next, meta) => {
        onPatch(next, meta)
        setNode(next)
      }}
      onCommitDef={vi.fn()}
      onTransition={vi.fn()}
      onHistoryBoundary={vi.fn()}
    />
  )
}

function viewOf(testId: string): EditorView {
  const root = screen.getByTestId(testId)
  const editor = root.querySelector<HTMLElement>('.cm-editor')
  const view = editor === null ? null : EditorView.findFromDOM(editor)
  if (view === null) throw new Error(`CodeMirror view not found: ${testId}`)
  return view
}

describe('RFC-267 script full-screen editor', () => {
  test('opens the shared full Dialog with the current language, body and fill layout', () => {
    render(<Harness initialNode={scriptNode({ language: 'node', script: 'const answer = 42' })} />)

    expect(screen.queryByTestId('script-body-fullscreen-dialog')).toBeNull()
    expect(screen.getAllByTestId('script-body-fullscreen-trigger')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('script-body-fullscreen-trigger'))

    const overlay = screen.getByTestId('script-body-fullscreen-dialog')
    expect(overlay.classList.contains('dialog--full')).toBe(true)
    expect(
      screen
        .getByRole('dialog', { name: '全屏编辑' })
        .classList.contains('script-code-editor-dialog'),
    ).toBe(true)
    const fullEditor = screen.getByTestId('script-body-editor-fullscreen')
    expect(fullEditor.getAttribute('data-language')).toBe('javascript')
    expect(fullEditor.getAttribute('data-fill')).toBe('true')
    expect(viewOf('script-body-editor-fullscreen').state.doc.toString()).toBe('const answer = 42')
  })

  test('one full-screen edit updates the inline buffer exactly once and keeps continuous history', async () => {
    render(<Harness initialNode={scriptNode()} />)
    const trigger = screen.getByTestId('script-body-fullscreen-trigger')
    trigger.focus()
    fireEvent.click(trigger)

    const fullView = viewOf('script-body-editor-fullscreen')
    act(() => {
      fullView.dispatch({
        changes: { from: 0, to: fullView.state.doc.length, insert: 'print("full screen")' },
      })
    })

    await waitFor(() => {
      expect(viewOf('script-body-editor').state.doc.toString()).toBe('print("full screen")')
    })
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect((onPatch.mock.calls[0]?.[0] as unknown as Record<string, unknown>).script).toBe(
      'print("full screen")',
    )
    expect(onPatch.mock.calls[0]?.[1]).toMatchObject({
      source: 'inspector',
      mergeKey: 'node:s1:script',
      transaction: 'update',
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('script-body-fullscreen-dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
    expect(viewOf('script-body-editor').state.doc.toString()).toBe('print("full screen")')
  })

  test('changing to another script node closes the old full-screen editing session', () => {
    const first = scriptNode({ id: 's1', script: 'print("first")' })
    const second = scriptNode({ id: 's2', script: 'print("second")' })
    const definition = {
      $schema_version: 4,
      inputs: [],
      nodes: [first, second],
      edges: [],
    } as unknown as WorkflowDefinition
    const props = {
      definition,
      agents: [] as Agent[],
      onChange: vi.fn(),
      onClose: vi.fn(),
    }
    const { rerender } = render(<NodeInspector {...props} selectedNodeId="s1" />)

    fireEvent.click(screen.getByTestId('script-body-fullscreen-trigger'))
    expect(viewOf('script-body-editor-fullscreen').state.doc.toString()).toBe('print("first")')

    rerender(<NodeInspector {...props} selectedNodeId="s2" />)
    expect(screen.queryByTestId('script-body-fullscreen-dialog')).toBeNull()
    expect(viewOf('script-body-editor').state.doc.toString()).toBe('print("second")')
    expect(props.onChange).not.toHaveBeenCalled()
  })

  test.each([
    {
      reason: 'scripts:author downgrade',
      lose: () => {
        permissionState.canAuthor = false
      },
      recover: () => {
        permissionState.canAuthor = true
      },
    },
    {
      reason: '/me error',
      lose: () => {
        permissionState.isError = true
      },
      recover: () => {
        permissionState.isError = false
      },
    },
  ])('$reason ends fullscreen and old callbacks cannot write after recovery', async (scenario) => {
    const initialNode = scriptNode()
    const view = render(<Harness initialNode={initialNode} />)
    fireEvent.click(screen.getByTestId('script-body-fullscreen-trigger'))
    const staleView = viewOf('script-body-editor-fullscreen')

    scenario.lose()
    view.rerender(<Harness initialNode={initialNode} />)
    expect(screen.getByTestId('script-inspector-no-view-permission')).toBeTruthy()
    expect(screen.queryByTestId('script-body-fullscreen-dialog')).toBeNull()
    expect(document.body.style.overflow).toBe('')

    scenario.recover()
    view.rerender(<Harness initialNode={initialNode} />)
    expect(screen.queryByTestId('script-inspector-no-view-permission')).toBeNull()
    expect(screen.queryByTestId('script-body-fullscreen-dialog')).toBeNull()

    // Recovery starts a closed, current generation. Its editor remains fully
    // usable, while the detached EditorView from before the loss cannot write
    // through its old onChange closure into this new session.
    fireEvent.click(screen.getByTestId('script-body-fullscreen-trigger'))
    const currentView = viewOf('script-body-editor-fullscreen')
    act(() => {
      currentView.dispatch({
        changes: { from: 0, to: currentView.state.doc.length, insert: 'print("fresh")' },
      })
    })
    await waitFor(() => {
      expect(viewOf('script-body-editor').state.doc.toString()).toBe('print("fresh")')
    })
    expect(onPatch).toHaveBeenCalledTimes(1)

    act(() => {
      staleView.dispatch({
        changes: { from: 0, to: staleView.state.doc.length, insert: 'print("stale")' },
      })
    })
    expect(staleView.state.doc.toString()).toBe('print("stale")')
    expect(onPatch).toHaveBeenCalledTimes(1)
    expect(viewOf('script-body-editor').state.doc.toString()).toBe('print("fresh")')
  })

  test('same-act cached permission loss fences a still-connected EditorView before React renders', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    const actorKey = ['auth', 'me', 'script-fullscreen-test-token'] as const
    const actor = (permissions: string[]) => ({
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
      source: 'session',
      permissions,
      linkedIdentities: [],
      pats: [],
    })
    queryClient.setQueryData(actorKey, actor(['scripts:author']))
    render(
      <QueryClientProvider client={queryClient}>
        <Harness initialNode={scriptNode()} />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByTestId('script-body-fullscreen-trigger'))
    const staleView = viewOf('script-body-editor-fullscreen')

    act(() => {
      queryClient.setQueryData(actorKey, actor([]))
      expect(staleView.dom.isConnected).toBe(true)
      staleView.dispatch({
        changes: { from: 0, to: staleView.state.doc.length, insert: 'print("blocked")' },
      })
    })

    // The imperative editor really dispatched; only the live authority fence
    // prevented that old callback from publishing a workflow mutation.
    expect(staleView.state.doc.toString()).toBe('print("blocked")')
    expect(onPatch).not.toHaveBeenCalled()
  })

  // RFC-270 显式改判（原断言：无 `scripts:author` 时得到一个「诚实的全屏只读
  // 视图」）。RFC-270 把「谁能看」并进「谁能写」——脚本正文是宿主要执行的代码，
  // 服务端已不再把它下发给无权限的读者，全屏里能显示的只有 `***`。所以「只读
  // 全屏」这个形态整个消失了：面板本身换成无权限占位，自然也没有全屏按钮。
  // 改判而不是删除，是为了让「无权限分支」在本文件里仍然有一条锁。
  test('RFC-270 改判：无 scripts:author 时整个面板换成占位，没有全屏入口', () => {
    permissionState.canAuthor = false
    render(<Harness initialNode={scriptNode()} />)

    expect(screen.getByTestId('script-inspector-no-view-permission')).toBeTruthy()
    expect(screen.queryByTestId('script-body-fullscreen-trigger')).toBeNull()
    expect(screen.queryByTestId('script-body-editor')).toBeNull()
    expect(document.body.textContent).not.toContain('print(')
  })
})

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

describe('RFC-267 full-screen layout contract', () => {
  test('the shared editor and Dialog flex chain own the available height', () => {
    expect(css).toMatch(/\.code-editor--fill[\s\S]*?height:\s*100%[\s\S]*?min-height:\s*0/)
    expect(css).toMatch(
      /\.script-code-editor-dialog \.dialog__body[\s\S]*?min-height:\s*0[\s\S]*?overflow:\s*hidden/,
    )
    expect(css).toMatch(
      /\.script-code-editor-dialog__editor[\s\S]*?flex:\s*1 1 auto[\s\S]*?min-height:\s*0/,
    )
  })

  test('phone layout becomes a true visual-viewport surface with safe-area padding', () => {
    expect(css).toMatch(
      /@media \(max-width:\s*720px\)[\s\S]*?\.dialog--full \.dialog__panel\.script-code-editor-dialog[\s\S]*?width:\s*100vw[\s\S]*?height:\s*100dvh[\s\S]*?safe-area-inset-top/,
    )
  })
})
