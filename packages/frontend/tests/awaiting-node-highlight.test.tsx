// Locks in "highlight the node the task is currently parked at for human action"
// — a review awaiting a decision (node_run `awaiting_review`) and a clarify /
// cross-clarify awaiting answers (node_run `awaiting_human`). Added 2026-06-26
// (用户："如果当前停留在检视、反问，也要高亮显示").
//
// Before this, the canvas showed these parked nodes as grey: canvasStatus mapped
// awaiting_review → 'pending' and had NO case for awaiting_human (→ undefined),
// and `statusOverlay` is never wired, so Clarify/CrossClarifyNode fell through
// mapFallbackStatus(undefined) → 'pending'. So the amber awaiting visual was dead
// on the run view. This test pins the fix across all three layers:
//   1. canvasStatus collapses BOTH awaiting_review and awaiting_human → 'awaiting'.
//   2. ReviewNode passes 'awaiting' through; Clarify/CrossClarifyNode translate it
//      back to their own amber 'awaiting_human' palette value.
//   3. styles.css gives [data-status='awaiting'] / [data-status='awaiting_human']
//      an amber (#d97706) breathing pulse with a reduced-motion fallback — the
//      same mechanism as the running pulse but a distinct hue (machine-running
//      blue vs needs-a-human amber).

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { canvasStatus } from '../src/routes/tasks.detail'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import { ClarifyNode } from '../src/components/canvas/nodes/ClarifyNode'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function nodeProps(data: Record<string, unknown>): any {
  return {
    id: 'n',
    type: 'x',
    data,
    selected: false,
    dragging: false,
    isConnectable: true,
    positionAbsoluteX: 0,
    positionAbsoluteY: 0,
    zIndex: 0,
  }
}

describe('canvasStatus collapses human-wait states to "awaiting"', () => {
  test('review awaiting a decision → awaiting (was "pending")', () => {
    expect(canvasStatus('awaiting_review')).toBe('awaiting')
  })
  test('clarify awaiting answers → awaiting (was undefined)', () => {
    expect(canvasStatus('awaiting_human')).toBe('awaiting')
  })
  test('running is unchanged (running highlight still its own state)', () => {
    expect(canvasStatus('running')).toBe('running')
  })
})

describe('nodes render the parked-for-human data-status', () => {
  test('ReviewNode passes the awaiting hint straight through', () => {
    render(
      <ReactFlowProvider>
        <ReviewNode
          {...nodeProps({
            nodeId: 'r',
            kind: 'review',
            title: 'review-target',
            inputPorts: [],
            outputPorts: ['approved_doc', 'approval_meta'],
            status: 'awaiting',
          })}
        />
      </ReactFlowProvider>,
    )
    const root = document.querySelector('.canvas-node--review')
    expect(root?.getAttribute('data-status')).toBe('awaiting')
  })

  test('ClarifyNode translates awaiting → its own amber awaiting_human', () => {
    render(
      <ReactFlowProvider>
        <ClarifyNode
          {...nodeProps({
            nodeId: 'c',
            kind: 'clarify',
            title: 'ask',
            inputPorts: [],
            outputPorts: [],
            status: 'awaiting',
          })}
        />
      </ReactFlowProvider>,
    )
    const root = document.querySelector('.canvas-node--clarify')
    expect(root?.getAttribute('data-status')).toBe('awaiting_human')
    expect(root?.className).toContain('canvas-node--clarify-awaiting_human')
  })

  test('CrossClarifyNode translates awaiting → awaiting_human', () => {
    render(
      <ReactFlowProvider>
        <CrossClarifyNode
          {...nodeProps({
            nodeId: 'x',
            kind: 'clarify-cross-agent',
            title: 'cross-ask',
            inputPorts: [],
            outputPorts: [],
            status: 'awaiting',
          })}
        />
      </ReactFlowProvider>,
    )
    const root = document.querySelector('.canvas-node--clarify-cross-agent')
    expect(root?.getAttribute('data-status')).toBe('awaiting_human')
    expect(root?.className).toContain('canvas-node--clarify-cross-agent-awaiting_human')
  })
})

describe('awaiting pulse styling (styles.css)', () => {
  async function styles(): Promise<string> {
    const here = path.dirname(fileURLToPath(import.meta.url))
    return fs.readFile(path.join(here, '../src/styles.css'), 'utf8')
  }

  test('both awaiting selectors drive the amber pulse animation', async () => {
    const css = await styles()
    expect(css).toContain('@keyframes canvas-node-awaiting-pulse')
    // The MAIN rule (not the reduced-motion one) groups both selectors and runs
    // the animation; [^}]* keeps the match inside this single rule body.
    expect(css).toMatch(
      /\.canvas-node\[data-status='awaiting'\],\s*\.canvas-node\[data-status='awaiting_human'\]\s*\{[^}]*animation:\s*canvas-node-awaiting-pulse/,
    )
    expect(css).toMatch(
      /\.canvas-node\[data-status='awaiting'\],\s*\.canvas-node\[data-status='awaiting_human'\]\s*\{[^}]*border-color:\s*#d97706/,
    )
  })

  test('the pulse uses the review/clarify amber #d97706 (distinct from running blue)', async () => {
    const css = await styles()
    expect(css).toContain('color-mix(in srgb, #d97706 55%, transparent)')
    expect(css).toContain('color-mix(in srgb, #d97706 0%, transparent)')
  })

  test('reduced-motion disables the awaiting pulse too (a11y)', async () => {
    const css = await styles()
    const disablesAwaiting =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^]*?\.canvas-node\[data-status='awaiting'\][^]*?animation:\s*none/.test(
        css,
      )
    expect(disablesAwaiting, 'reduced-motion does not disable the awaiting animation').toBe(true)
  })

  test('loop-body tint is still declared before the awaiting overlay (border wins on run view)', async () => {
    const css = await styles()
    const loopIdx = css.indexOf(".canvas-node[data-loop-body='true']")
    const awaitingIdx = css.indexOf(".canvas-node[data-status='awaiting']")
    expect(loopIdx).toBeGreaterThanOrEqual(0)
    expect(awaitingIdx).toBeGreaterThanOrEqual(0)
    expect(loopIdx).toBeLessThan(awaitingIdx)
  })
})
