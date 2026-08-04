// Regression lock for the user-reported RFC-253 canvas inconsistency.
//
// The first script card used the shared CanvasNodeCard shell, but the canvas
// projection never supplied its language / dependency / safety metadata and
// the new Scripts picker category was left outside the colour-family rules.
// That combination made the card render as a generic, mostly empty outlier.

import { cleanup, render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { __testToFlowNodes } from '../src/components/canvas/WorkflowCanvas'
import { ScriptNode, type ScriptNodeData } from '../src/components/canvas/nodes/ScriptNode'
import { setLanguage } from '../src/i18n'
import '../src/i18n'

const scriptDefinition = {
  id: 'script_verify',
  kind: 'script',
  title: 'Verify release',
  language: 'python',
  script: "print('ok')\n",
  dependencies: ['requests==2.32.3', 'pyyaml==6.0.2'],
  network: 'deny',
  readonly: true,
  position: { x: 120, y: 80 },
} as unknown as WorkflowNode

afterEach(() => {
  cleanup()
  setLanguage('en-US')
})

describe('script canvas card visual contract', () => {
  test('canvas projection exposes the metadata promised by the script card', () => {
    const [flowNode] = __testToFlowNodes([scriptDefinition], [], [], undefined, undefined)

    expect(flowNode?.data).toMatchObject({
      kind: 'script',
      title: 'Verify release',
      language: 'python',
      dependencyCount: 2,
      networkDenied: true,
      scriptReadonly: true,
    })
  })

  test('renders metadata inside the same shared card shell as other leaf nodes', () => {
    setLanguage('en-US')
    const [flowNode] = __testToFlowNodes([scriptDefinition])
    const data = flowNode?.data as ScriptNodeData
    const { container } = render(
      <ReactFlowProvider>
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <ScriptNode {...({ id: 'script_verify', data, selected: false } as any)} />
      </ReactFlowProvider>,
    )

    const card = container.querySelector('.canvas-node--script')
    expect(card?.classList.contains('canvas-node--card')).toBe(true)
    expect(card?.getAttribute('data-node-kind')).toBe('script')
    expect(container.querySelector('.canvas-node__title')?.textContent).toBe('Verify release')
    expect(container.querySelector('[data-testid="script-node-language"]')?.textContent).toBe(
      'python',
    )
    expect(container.querySelector('[data-testid="script-node-deps"]')?.textContent).toContain('2')
    expect(container.querySelector('[data-testid="script-node-network-deny"]')).not.toBeNull()
    expect(container.querySelector('[data-testid="script-node-readonly"]')).not.toBeNull()
  })

  test('canvas and picker use one explicit Scripts visual family', () => {
    const css = readFileSync(resolve(import.meta.dirname, '..', 'src', 'styles.css'), 'utf8')

    expect(css).toMatch(
      /\.workflow-node-picker__item\[data-category='scripts'\][^{]*\{[^}]*border-inline-start-color:\s*#0e7490/s,
    )
    expect(css).toMatch(
      /\.workflow-node-picker__type-chip\[data-category='scripts'\][^{]*\{[^}]*#0e7490/s,
    )
    expect(css).toMatch(
      /\.canvas-node--card\[data-node-kind='script'\][^{]*\{[^}]*--node-accent:\s*#0e7490/s,
    )
  })
})
