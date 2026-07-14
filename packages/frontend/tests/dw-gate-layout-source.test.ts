// Regression lock for the dw confirm-gate layout (「编排确认门太大」,
// 2026-07-14).
//
// History: DynamicWorkflowPanel stacks its gate/progress card above the DAG
// preview inside `.task-canvas-layout`, which fills the whole tab pane
// (`.task-detail__pane > .task-canvas-layout { height: 100% }`). A CSS grid
// with only auto rows STRETCHES them equally to fill that height
// (align-content default), so the two-line confirm card inflated to half the
// pane (~380px of empty card) while the preview got squeezed. The fix is the
// `--dw` modifier: explicit `grid-template-rows: auto minmax(0, 1fr)` — card
// row hugs content, preview row absorbs the rest.
//
// happy-dom computes no real layout, so the durable contract is source-level:
// the modifier rule must exist with the row template, and the panel must
// actually carry the modifier class (the companion render assertion lives in
// dynamic-workflow-panel.test.tsx).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const css = readFileSync(resolve(__dirname, '..', 'src', 'styles.css'), 'utf8')
const panelSrc = readFileSync(
  resolve(__dirname, '..', 'src', 'components', 'workgroup', 'DynamicWorkflowPanel.tsx'),
  'utf8',
)

describe('dw orchestration pane layout — gate card hugs content', () => {
  test('.task-canvas-layout--dw pins explicit rows (auto card + 1fr preview)', () => {
    const m = /\.task-canvas-layout--dw\s*\{([^}]*)\}/.exec(css)
    expect(m, 'styles.css must define .task-canvas-layout--dw').toBeTruthy()
    expect(m?.[1]?.replace(/\s+/g, ' ')).toContain('grid-template-rows: auto minmax(0, 1fr)')
  })

  test('the preview row keeps a usable min-height on short windows', () => {
    const m = /\.task-canvas-layout--dw\s*>\s*\.canvas-frame--task\s*\{([^}]*)\}/.exec(css)
    expect(m).toBeTruthy()
    expect(m?.[1]).toContain('min-height')
  })

  test('DynamicWorkflowPanel carries the --dw modifier on its layout container', () => {
    expect(panelSrc).toContain('"task-canvas-layout task-canvas-layout--dw"')
  })
})
