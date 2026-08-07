// RFC-267 — script bodies can escape the 360–420px inspector without
// creating a second draft/save model. These tests lock the full-screen Dialog,
// the shared controlled buffer, permission parity and focus restoration.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EditorView } from '@codemirror/view'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useState } from 'react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { Agent, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import i18n from '../src/i18n'
import { ScriptEdit } from '../src/components/canvas/inspector/ScriptEdit'
import type { InspectorChangeMeta } from '../src/components/canvas/NodeInspector'

const permissionState = vi.hoisted(() => ({ canAuthor: true }))
vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'admin', status: 'active' },
      source: 'session',
      permissions: permissionState.canAuthor ? ['scripts:author'] : [],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => permissionState.canAuthor,
}))

const onPatch = vi.fn<(node: WorkflowNode, meta: InspectorChangeMeta) => void>()

beforeEach(async () => {
  permissionState.canAuthor = true
  onPatch.mockClear()
  await i18n.changeLanguage('zh-CN')
})

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
