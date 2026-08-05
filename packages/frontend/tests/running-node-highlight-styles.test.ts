// Locks in the "highlight the running node" treatment on the task-detail canvas
// (2026-06-26 request "高亮显示正在运行的节点").
//
// Before this change a running node only got `border-color: var(--accent)` — a
// single line, indistinguishable on a busy canvas, and WORSE: the
// `.canvas-node[data-loop-body='true']` rule sat *after* it at equal specificity
// (both one class + one attribute), so its blue border silently overrode the
// running border for any node inside a loop wrapper → a running-in-loop node
// never lit up at all.
//
// The fix: (1) move the loop-body rule ABOVE the status overlay so a node's live
// run status owns the border on the run view, and (2) give `running` a breathing
// accent halo (the same box-shadow ring language as the RFC-106
// canvas-connect-*-pulse hints), with a reduced-motion fallback.
//
// These are source-text assertions because the behavior is pure CSS — the data
// layer (status → CanvasNodeData.status) is already covered by status-canvas.test.ts.
// If a future refactor reorders the rules (reintroducing the loop override) or
// drops the pulse / reduced-motion fallback, this goes red at PR time.

import { describe, expect, test } from 'vitest'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

async function styles(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url))
  return fs.readFile(path.join(here, '../src/styles.css'), 'utf8')
}

function block(css: string, selector: string): string {
  const idx = css.indexOf(selector + ' {')
  expect(idx, `selector ${selector} { not found in styles.css`).toBeGreaterThanOrEqual(0)
  const end = css.indexOf('}', idx)
  return css.slice(idx, end + 1)
}

describe('running-node highlight on the task-detail canvas', () => {
  test('loop-body tint is declared before the status overlay so live status wins the border', async () => {
    const css = await styles()
    const loopIdx = css.indexOf(".canvas-node[data-loop-body='true']")
    const runIdx = css.indexOf(".canvas-node[data-status='running']")
    expect(loopIdx, 'loop-body rule missing').toBeGreaterThanOrEqual(0)
    expect(runIdx, 'running rule missing').toBeGreaterThanOrEqual(0)
    // Equal specificity → source order decides. Loop-body MUST come first so the
    // running/done/failed status border is the one that paints on the run view.
    expect(loopIdx).toBeLessThan(runIdx)
  })

  test('the running node gets an accent border and the breathing pulse animation', async () => {
    const css = await styles()
    const rule = block(css, ".canvas-node[data-status='running']")
    expect(rule).toContain('border-color: var(--accent)')
    expect(rule).toContain('animation: canvas-node-running-pulse')
  })

  test('the pulse keyframes exist and use the accent halo (matching the connect-* pulse language)', async () => {
    const css = await styles()
    expect(css).toContain('@keyframes canvas-node-running-pulse')
    const kfIdx = css.indexOf('@keyframes canvas-node-running-pulse')
    const kf = css.slice(kfIdx, kfIdx + 500)
    // Expanding outer ring in the accent hue + a constant inner ring that reads
    // as a bolder border without changing border-width (no port/edge reflow).
    expect(kf).toContain('color-mix(in srgb, var(--accent)')
    expect(kf).toContain('inset 0 0 0 1px var(--accent)')
  })

  test('reduced-motion disables the infinite pulse but keeps a static halo (a11y)', async () => {
    const css = await styles()
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    // A reduced-motion block must turn the running pulse off.
    const matches =
      /@media \(prefers-reduced-motion: reduce\)\s*\{[^]*?\.canvas-node\[data-status='running'\][^]*?animation:\s*none/.test(
        css,
      )
    expect(matches, 'reduced-motion block does not disable the running animation').toBe(true)
  })
})
