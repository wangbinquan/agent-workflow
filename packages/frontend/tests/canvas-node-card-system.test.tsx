import type { ElementType } from 'react'
import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import { CallWorkflowNode } from '../src/components/canvas/nodes/CallWorkflowNode'
import { CallWorkgroupNode } from '../src/components/canvas/nodes/CallWorkgroupNode'
import { ClarifyNode } from '../src/components/canvas/nodes/ClarifyNode'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'
import { InputNode } from '../src/components/canvas/nodes/InputNode'
import { OutputNode } from '../src/components/canvas/nodes/OutputNode'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function nodeData(kind: CanvasNodeData['kind']): CanvasNodeData {
  return {
    surface: 'editor',
    nodeId: `${kind}-node`,
    kind,
    title: `${kind} title`,
    inputPorts: ['request'],
    outputPorts: ['result'],
    ...(kind === 'call-workflow' ? { workflowName: 'release-pipeline' } : {}),
    ...(kind === 'call-workgroup' ? { workgroupName: 'review-council' } : {}),
  }
}

function renderNode(Component: ElementType, data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      <Component data={data} selected={false} id={data.nodeId} type={data.kind} />
    </ReactFlowProvider>,
  )
}

const CARD_RENDERERS: Array<{
  kind: CanvasNodeData['kind']
  Component: ElementType
}> = [
  { kind: 'agent-single', Component: AgentNode },
  { kind: 'input', Component: InputNode },
  { kind: 'output', Component: OutputNode },
  { kind: 'review', Component: ReviewNode },
  { kind: 'clarify', Component: ClarifyNode },
  { kind: 'clarify-cross-agent', Component: CrossClarifyNode },
  { kind: 'call-workflow', Component: CallWorkflowNode },
  { kind: 'call-workgroup', Component: CallWorkgroupNode },
]

describe('canvas card visual system', () => {
  test.each(CARD_RENDERERS)('$kind uses the shared card shell', ({ kind, Component }) => {
    const { container } = renderNode(Component, nodeData(kind))
    const card = container.querySelector(`.canvas-node--card[data-node-kind="${kind}"]`)

    expect(card).not.toBeNull()
    expect(card?.querySelector('.canvas-node__icon')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__identity')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__kind')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__title')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__configuration')).not.toBeNull()
  })

  test('shared CSS owns the chrome without a transform-sensitive decorative rail', () => {
    const css = readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8')

    expect(css).toContain('.canvas-node--card {')
    // Regression: an absolutely positioned 2px top rail still bled across the
    // rounded border once xyflow scaled the card onto fractional pixels. The
    // card already carries its accent through border/icon/type, so keeping a
    // second pseudo-element stroke is both redundant and visually unstable.
    expect(css).not.toContain('.canvas-node--card::before')
    expect(css).toContain('.canvas-node--card .canvas-node__header')
    expect(css).toContain('.canvas-node__icon')
    expect(css).toContain(".canvas-node--card[data-node-kind='agent-single']")
    expect(css).toContain(".canvas-node--card[data-node-kind='call-workgroup']")
  })

  test('cross-clarify editor card reserves readable identity space beside its port labels', () => {
    const css = readFileSync(path.resolve(__dirname, '../src/styles.css'), 'utf8')
    const start = css.indexOf(
      ".canvas-node.canvas-node--clarify-cross-agent[data-surface='editor']",
    )
    expect(start).toBeGreaterThanOrEqual(0)
    const rule = css.slice(start, css.indexOf('}', start) + 1)

    // The shared 34px icon plus the existing 88px output-label gutter leaves
    // only ~95px at the generic 240px width, truncating `CROSS-CLARIFY`.
    expect(rule).toContain('width: 280px;')
    expect(rule).toContain('min-width: 280px;')

    // Keep the older review exception effective too: the generic editor rule
    // has three specificity units, so a two-unit kind selector never applied
    // its documented 260px width even though it appeared later in the file.
    expect(css).toContain(".canvas-node.canvas-node--review[data-surface='editor']")
  })

  test('an unwired review card tells the author which required input is missing', () => {
    const { container } = renderNode(ReviewNode, nodeData('review'))
    const card = container.querySelector('.canvas-node--review')

    expect(card?.getAttribute('data-review-input-state')).toBe('unset')
    expect(card?.querySelector('.canvas-node__fact-band')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__review-source-unset')?.textContent).toBe(
      'Connect a Markdown output to review',
    )
  })
})
