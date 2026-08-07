// Regression lock for the code-host call node's visual and interaction-facing
// canvas contract. RFC-269 initially reused ScriptNode's badge row, fell back
// to the generic picker colour, showed a technical call_api_* id as the title,
// and labelled a harmless GET as destructive whenever DELETE was merely
// allowed. The card now projects the actual operation from the shared action
// registry and uses the same fact-band hierarchy as other resource-rich cards.

import { act, cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { __testToFlowNodes, WorkflowCanvas } from '../src/components/canvas/WorkflowCanvas'
import {
  CodeHostCallNode,
  type CodeHostCallNodeData,
} from '../src/components/canvas/nodes/CodeHostCallNode'
import i18n, { setLanguage } from '../src/i18n'

function codeHostNode(extra: Record<string, unknown> = {}): WorkflowNode {
  return {
    id: 'call_api_verify',
    kind: 'code-host-call',
    provider: 'gitlab',
    action: 'comment.reply-thread',
    params: {},
    ...extra,
  } as WorkflowNode
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeProps(data: CodeHostCallNodeData): any {
  return {
    id: data.nodeId,
    type: 'code-host-call',
    data,
    selected: false,
    dragging: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
  }
}

afterEach(() => {
  cleanup()
  setLanguage('en-US')
})

describe('code-host canvas card', () => {
  test('projection derives a human title and the real HTTP method from the action registry', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([codeHostNode()])

    expect(flowNode?.data).toMatchObject({
      kind: 'code-host-call',
      title: 'Reply to existing review discussion',
      provider: 'gitlab',
      action: 'comment.reply-thread',
      method: 'POST',
    })
  })

  test('localized default title updates immediately when the UI language changes', async () => {
    await i18n.changeLanguage('en-US')
    const definition = {
      $schema_version: 4 as const,
      inputs: [],
      nodes: [codeHostNode()],
      edges: [],
    }
    const { container } = render(<WorkflowCanvas surface="task" definition={definition} readOnly />)

    expect(container.querySelector('.canvas-node__title')?.textContent).toBe(
      'Reply to existing review discussion',
    )

    await act(async () => {
      await i18n.changeLanguage('zh-CN')
    })

    expect(container.querySelector('.canvas-node__title')?.textContent).toBe('回复已有评审讨论')
  })

  test('default title avoids duplicate action text while keeping provider and method visible', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([codeHostNode()])
    const { container } = render(
      <ReactFlowProvider>
        <CodeHostCallNode {...nodeProps(flowNode?.data as CodeHostCallNodeData)} />
      </ReactFlowProvider>,
    )

    const card = container.querySelector('.canvas-node--code-host')
    expect(card?.classList.contains('canvas-node--card')).toBe(true)
    expect(card?.querySelector('.canvas-node__fact-band')).not.toBeNull()
    expect(container.querySelector('[data-testid="code-host-node-provider"]')?.textContent).toBe(
      'GitLab',
    )
    expect(container.querySelector('[data-testid="code-host-node-method"]')?.textContent).toBe(
      'POST',
    )
    expect(container.querySelector('[data-testid="code-host-node-action"]')).toBeNull()
  })

  test('custom title keeps the underlying action visible in the fact band', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([codeHostNode({ title: 'Reply to reviewer' })])
    const { container } = render(
      <ReactFlowProvider>
        <CodeHostCallNode {...nodeProps(flowNode?.data as CodeHostCallNodeData)} />
      </ReactFlowProvider>,
    )

    expect(container.querySelector('.canvas-node__title')?.textContent).toBe('Reply to reviewer')
    expect(container.querySelector('[data-testid="code-host-node-action"]')?.textContent).toBe(
      'Reply to existing review discussion',
    )
  })

  test('unsupported provider binding is explicit on the card', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([
      codeHostNode({ provider: 'github', action: 'thread.resolve' }),
    ])
    const data = flowNode?.data as CodeHostCallNodeData
    expect(data.unsupported).toBe(true)
    expect(data.method).toBeUndefined()

    const { container } = render(
      <ReactFlowProvider>
        <CodeHostCallNode {...nodeProps(data)} />
      </ReactFlowProvider>,
    )
    expect(container.querySelector('[data-testid="code-host-node-unsupported"]')?.textContent).toBe(
      'unsupported here',
    )
  })

  test('DELETE warning follows the configured method, not the broader permission flag', () => {
    const [getNode] = __testToFlowNodes([
      codeHostNode({
        action: 'custom',
        request: { method: 'GET', path: '/projects/example' },
        allowDestructive: true,
      }),
    ])
    const [deleteNode] = __testToFlowNodes([
      codeHostNode({
        action: 'custom',
        request: { method: 'DELETE', path: '/projects/example' },
        allowDestructive: true,
      }),
    ])

    expect(getNode?.data).toMatchObject({ method: 'GET', destructive: false })
    expect(deleteNode?.data).toMatchObject({ method: 'DELETE', destructive: true })
  })

  test('canvas and picker use one explicit Integrations visual family', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')

    expect(css).toMatch(
      /\.workflow-node-picker__item\[data-category='integrations'\][^{]*\{[^}]*border-inline-start-color:\s*#4f46e5/s,
    )
    expect(css).toMatch(
      /\.workflow-node-picker__type-chip\[data-category='integrations'\][^{]*\{[^}]*#4f46e5/s,
    )
    expect(css).toMatch(
      /\.canvas-node--card\[data-node-kind='code-host-call'\][^{]*\{[^}]*--node-accent:\s*#4f46e5/s,
    )
  })
})
