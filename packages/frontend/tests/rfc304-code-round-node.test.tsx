// RFC-304 — the synthesized `code-round` node must read as a first-class card,
// not as the empty outlier a new kind defaults to.
//
// Modelled on script-node-card-style.test.tsx, and for the same reason: RFC-253
// shipped a card whose metadata the canvas projection never supplied, so it
// rendered with em-dash placeholders over a fully-populated definition. This
// kind is MORE exposed to that bug, not less — nobody authors it, so nobody
// sees it until a task is already finished and someone opens the snapshot
// looking for exactly the two facts it carries (which capability, which round).
//
// The visual-family assertion is here for the §Frontend UI consistency rule:
// a kind with no `--node-accent` inherits the default and reads as a visual
// island on a canvas where every other kind is colour-coded.

import { cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { __testToFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import { CodeRoundNode, type CodeRoundNodeData } from '../src/components/canvas/nodes/CodeRoundNode'
import { setLanguage } from '../src/i18n'
import '../src/i18n'

const roundDefinition = {
  id: 'round_1',
  kind: 'code-round',
  title: 'MR review round 1',
  capability: 'mr-review',
  roundSeq: 1,
  position: { x: 40, y: 40 },
} as unknown as WorkflowNode

afterEach(() => {
  cleanup()
  setLanguage('en-US')
})

describe('RFC-304 code-round canvas card', () => {
  test('canvas projection carries the capability and round the card promises', () => {
    const [flowNode] = __testToFlowNodes([roundDefinition], [], [], undefined, undefined)

    expect(flowNode?.data).toMatchObject({
      kind: 'code-round',
      capability: 'mr-review',
      roundSeq: 1,
    })
  })

  test('renders in the shared card shell with the capability spelled out', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([roundDefinition])
    const data = flowNode?.data as CodeRoundNodeData
    const { container } = render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <CodeRoundNode {...({ id: 'round_1', data, selected: false } as any)} />
      </ReactFlowProvider>,
    )

    const card = container.querySelector('.canvas-node--code-round')
    expect(card?.classList.contains('canvas-node--card')).toBe(true)
    expect(card?.getAttribute('data-node-kind')).toBe('code-round')
    expect(card?.getAttribute('data-code-capability')).toBe('mr-review')
    expect(container.querySelector('.canvas-node__title')?.textContent).toBe('MR review round 1')
    // The raw slug is never what we show — a reader gets the capability's name.
    const capability = container.querySelector('[data-testid="code-round-node-capability"]')
    expect(capability?.textContent).toBe('MR review')
    expect(container.querySelector('[data-testid="code-round-node-seq"]')?.textContent).toContain(
      '1',
    )
  })

  test('an unknown capability degrades to its slug instead of a missing-key string', () => {
    // Snapshots outlive the code that wrote them: a task run before a
    // capability was renamed (or after it was removed) must still render.
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([
      { ...roundDefinition, capability: 'not-a-capability' } as unknown as WorkflowNode,
    ])
    const data = flowNode?.data as CodeRoundNodeData
    const { container } = render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <CodeRoundNode {...({ id: 'round_1', data, selected: false } as any)} />
      </ReactFlowProvider>,
    )
    expect(container.querySelector('[data-testid="code-round-node-capability"]')?.textContent).toBe(
      'not-a-capability',
    )
  })

  test('a definition with neither field still renders rather than throwing', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([
      { id: 'round_bare', kind: 'code-round', position: { x: 0, y: 0 } } as unknown as WorkflowNode,
    ])
    const data = flowNode?.data as CodeRoundNodeData
    const { container } = render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <CodeRoundNode {...({ id: 'round_bare', data, selected: false } as any)} />
      </ReactFlowProvider>,
    )
    expect(container.querySelector('[data-testid="code-round-node-capability"]')?.textContent).toBe(
      '—',
    )
    expect(container.querySelector('[data-testid="code-round-node-seq"]')).toBeNull()
  })

  test('the kind has its own accent, like every other canvas kind', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')
    expect(css).toMatch(
      /\.canvas-node--card\[data-node-kind='code-round'\][^{]*\{[^}]*--node-accent:\s*#[0-9a-f]{6}/s,
    )
  })
})
