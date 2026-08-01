// Regression lock for the call-node card refresh requested after RFC-243.
// Call-workflow / call-workgroup originally copied the legacy text-only node
// chrome, so the newly introduced composition nodes looked older than the
// workflow/workgroup resource surfaces they reference. Keep both cards on the
// shared resource-icon + reference-band contract, and keep the picker accents
// aligned with the corresponding canvas card.

import { cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { CallWorkflowNode } from '../src/components/canvas/nodes/CallWorkflowNode'
import { CallWorkgroupNode } from '../src/components/canvas/nodes/CallWorkgroupNode'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeProps(data: Record<string, unknown>): any {
  return {
    id: String(data.nodeId ?? 'call'),
    type: String(data.kind ?? 'call-workflow'),
    data,
    selected: false,
    dragging: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
  }
}

afterEach(() => cleanup())

describe('call resource canvas cards', () => {
  test('call-workflow uses the shared workflow icon and a resolved reference band', () => {
    const { container } = render(
      <ReactFlowProvider>
        <CallWorkflowNode
          {...nodeProps({
            nodeId: 'call-wf',
            kind: 'call-workflow',
            title: 'Design review',
            workflowName: 'review-pipeline',
            inputPorts: ['brief'],
            outputPorts: ['report'],
            surface: 'editor',
          })}
        />
      </ReactFlowProvider>,
    )

    const card = container.querySelector('.canvas-node--call-workflow')
    expect(card?.classList.contains('canvas-node--call')).toBe(true)
    expect(card?.getAttribute('data-reference-state')).toBe('resolved')
    expect(card?.querySelector('[data-icon="workflow"]')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__call-reference code')?.textContent).toBe(
      'review-pipeline',
    )
  })

  test('default resource title is not repeated in a second reference band', () => {
    const { container } = render(
      <ReactFlowProvider>
        <CallWorkflowNode
          {...nodeProps({
            nodeId: 'call-wf',
            kind: 'call-workflow',
            title: 'review-pipeline',
            workflowName: 'review-pipeline',
            inputPorts: [],
            outputPorts: ['report'],
            surface: 'editor',
          })}
        />
      </ReactFlowProvider>,
    )

    expect(container.querySelector('.canvas-node__call-reference')).toBeNull()
  })

  test('call-workgroup uses the shared workgroup icon and keeps unset state explicit', () => {
    const { container } = render(
      <ReactFlowProvider>
        <CallWorkgroupNode
          {...nodeProps({
            nodeId: 'call-wg',
            kind: 'call-workgroup',
            title: 'Council review',
            workgroupName: '',
            inputPorts: [],
            outputPorts: ['result'],
            surface: 'editor',
          })}
        />
      </ReactFlowProvider>,
    )

    const card = container.querySelector('.canvas-node--call-workgroup')
    expect(card?.classList.contains('canvas-node--call')).toBe(true)
    expect(card?.getAttribute('data-reference-state')).toBe('unset')
    expect(card?.querySelector('[data-icon="workgroup"]')).not.toBeNull()
    expect(card?.querySelector('.canvas-node__call-reference code')).toBeNull()
    expect(card?.querySelector('.canvas-node__call-reference')?.textContent?.trim()).not.toBe('')
  })
})

describe('agent resource identity', () => {
  // 2026-08-01 regression: a custom node display name used to replace the
  // configured agent name entirely, unlike the two call-resource cards.
  test('custom node title keeps the referenced agent name in the shared band', () => {
    const { container } = render(
      <ReactFlowProvider>
        <AgentNode
          {...nodeProps({
            nodeId: 'agent-step',
            kind: 'agent-single',
            title: 'Review the patch',
            agentName: 'code-auditor',
            inputPorts: [],
            outputPorts: ['report'],
            surface: 'editor',
          })}
        />
      </ReactFlowProvider>,
    )

    expect(container.querySelector('.canvas-node__title')?.textContent).toBe('Review the patch')
    expect(container.querySelector('.canvas-node__call-reference code')?.textContent).toBe(
      'code-auditor',
    )
  })

  test('default agent title is not repeated in a second reference band', () => {
    const { container } = render(
      <ReactFlowProvider>
        <AgentNode
          {...nodeProps({
            nodeId: 'agent-step',
            kind: 'agent-single',
            title: 'code-auditor',
            agentName: 'code-auditor',
            inputPorts: [],
            outputPorts: ['report'],
            surface: 'editor',
          })}
        />
      </ReactFlowProvider>,
    )

    expect(container.querySelector('.canvas-node__call-reference')).toBeNull()
  })
})

describe('call card style contract', () => {
  test('canvas and picker share per-resource accents instead of generic legacy rows', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')

    expect(css).toContain('.canvas-node--card {')
    expect(css).toContain(".canvas-node--card[data-node-kind='call-workflow']")
    expect(css).toContain(".canvas-node--card[data-node-kind='call-workgroup']")
    expect(css).toContain('.canvas-node__icon')
    expect(css).toContain('.canvas-node__call-reference')
    expect(css).toContain("[data-node-kind='call-workflow']")
    expect(css).toContain("[data-node-kind='call-workgroup']")
  })
})
