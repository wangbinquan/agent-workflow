import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ReactFlowProvider } from '@xyflow/react'
import { render } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'

function renderAgent(data: CanvasNodeData, selected = false) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <AgentNode {...({ id: data.nodeId, type: data.kind, data, selected } as any)} />
    </ReactFlowProvider>,
  )
}

function data(surface: CanvasNodeData['surface']): CanvasNodeData {
  return {
    surface,
    nodeId: 'agent-technical-id',
    kind: 'agent-single',
    title: 'Build API',
    inputPorts: ['request'],
    outputPorts: ['result'],
    validation: { errors: 2, warnings: 1 },
  }
}

describe('WorkflowCanvas surface isolation', () => {
  test('editor card shows business/configuration state while task keeps its legacy technical id', () => {
    const editor = renderAgent(data('editor'), true)
    const editorCard = editor.container.querySelector('.canvas-node')
    expect(editorCard?.getAttribute('data-surface')).toBe('editor')
    expect(editorCard?.classList.contains('canvas-node--selected')).toBe(true)
    expect(editor.container.querySelector('.canvas-node__title')?.textContent).toBe('Build API')
    expect(editor.container.querySelector('.canvas-node__configuration')?.textContent).toMatch(
      /1.*1/,
    )
    expect(editor.container.querySelector('.canvas-node__id')).toBeNull()
    expect(editor.container.querySelector('.canvas-node__validation')?.textContent).toMatch(/2.*1/)
    editor.unmount()

    const task = renderAgent(data('task'))
    expect(task.container.querySelector('.canvas-node')?.getAttribute('data-surface')).toBe('task')
    expect(task.container.querySelector('.canvas-node__id')?.textContent).toBe('agent-technical-id')
    expect(task.container.querySelector('.canvas-node__configuration')).toBeNull()
    expect(task.container.querySelector('.canvas-node__validation')).toBeNull()
  })

  test('production call sites are explicit and editor-only sizing/hit-area CSS is scoped', () => {
    const root = resolve(import.meta.dirname, '..', 'src')
    expect(readFileSync(resolve(root, 'routes/workflows.edit.tsx'), 'utf8')).toContain(
      'surface="editor"',
    )
    expect(readFileSync(resolve(root, 'routes/tasks.detail.tsx'), 'utf8')).toContain(
      'surface="task"',
    )
    expect(
      readFileSync(resolve(root, 'components/workgroup/DynamicWorkflowPanel.tsx'), 'utf8'),
    ).toContain('surface="workgroup-preview"')

    const css = readFileSync(resolve(root, 'styles.css'), 'utf8')
    expect(css).toMatch(
      /\.canvas-node\[data-surface='editor'\]:not\(\.canvas-node--wrapper-group\)[^{]*\{[^}]*width: 240px/s,
    )
    expect(css).toMatch(
      /\.canvas-node\[data-surface='editor'\]\s+\.canvas-node__handle:not\(\.canvas-node__handle--catchall\)::after\s*\{[^}]*inset: -8px/s,
    )
  })
})
