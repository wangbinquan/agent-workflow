// RFC-007 → RFC-354 source-level regression guard. The runtime / JSDOM tests
// (connection-sync.test.ts + canvas-review-output-drag.test.tsx) exercise
// behavior; this file additionally pins the structural contracts that a
// future refactor could erode silently — imports, exported symbols,
// hand-coded sentinel ids, and (RFC-354) the ABSENCE of any v5 PortRef
// double-write anywhere on the connect / inspector / load path.
//
// Pattern follows the [feedback_post_commit_ci_check] "source-code-level
// fallback": JSDOM does not run xyflow's drag-and-drop, and the connect
// path's behavior depends on the WorkflowCanvas hooking the same
// connection-sync entry points the inspectors do. If a refactor removes the
// import, the runtime test would still pass (the old behavior re-emerges
// as a regression) but this file would flag it.
//
// Link: design/RFC-007-canvas-review-output-drag/design.md §8.4,
//       design/RFC-354-*/design.md (schema v6: every PortRef is an edge)

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')

const REVIEW_NODE_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'nodes', 'ReviewNode.tsx')
const CONNECTION_SYNC_TS = resolve(FRONTEND_SRC, 'components', 'canvas', 'connectionSync.ts')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const WORKFLOW_TRANSITION_TS = resolve(FRONTEND_SRC, 'lib', 'workflow-transition.ts')
const WORKFLOW_PLAN_TS = resolve(FRONTEND_SRC, 'lib', 'workflow-connection-plan.ts')
const SHARED_REVIEW_TS = resolve(__dirname, '..', '..', 'shared', 'src', 'reviewMultiDoc.ts')
const WORKFLOWS_EDIT_TSX = resolve(FRONTEND_SRC, 'routes', 'workflows.edit.tsx')
const STYLES_CSS = resolve(FRONTEND_SRC, 'styles.css')
const INSPECTOR_DIR = resolve(FRONTEND_SRC, 'components', 'canvas', 'inspector')

describe('RFC-007 source-level guard', () => {
  test('connectionSync.ts exists and exports the edge-only helpers + sentinel', () => {
    expect(existsSync(CONNECTION_SYNC_TS)).toBe(true)
    const src = readFileSync(CONNECTION_SYNC_TS, 'utf8')
    expect(src).toContain('export const REVIEW_INPUT_HANDLE_ID = REVIEW_INPUT_PORT_NAME')
    expect(readFileSync(SHARED_REVIEW_TS, 'utf8')).toMatch(
      /export const REVIEW_INPUT_PORT_NAME\s*=\s*['"]__review_input__['"]/,
    )
    expect(src).toMatch(/export function applyConnectionForReviewOutput\b/)
    expect(src).toMatch(/export function inboundPortNames\b/)
    expect(src).toMatch(/export function uniquePortName\b/)
    // RFC-354: the mirror-side helpers are gone for good.
    expect(src).not.toMatch(
      /applyDisconnectForReviewOutput|syncEdgeFromFormField|healFieldEdgeConsistency/,
    )
  })

  test('ReviewNode.tsx renders the named target Handle + drops the old "intentionally off" note', () => {
    const tsx = readFileSync(REVIEW_NODE_TSX, 'utf8')
    expect(tsx).toContain('REVIEW_INPUT_HANDLE_ID')
    expect(tsx).toContain('type="target"')
    // The pre-RFC-007 reasoning must be gone — it claimed the catch-all
    // strip was off, which is no longer the design.
    expect(tsx).not.toContain('Catch-all inbound strip is intentionally off')
    // RFC-354: the card reads the edge-derived `reviewSource` slot, never a node field.
    expect(tsx).toContain('data.reviewSource')
    expect(tsx).not.toMatch(/\.inputSource\b/)
  })

  test('WorkflowCanvas delegates connect semantics to the planner/reconciler chokepoint', () => {
    const tsx = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(tsx).toContain('planWorkflowConnection')
    expect(tsx).toContain('applyWorkflowTransition')
    const transition = readFileSync(WORKFLOW_TRANSITION_TS, 'utf8')
    expect(transition).toContain('applyConnectionForReviewOutput')
    expect(transition).not.toContain('applyDisconnectForReviewOutput')
    expect(readFileSync(WORKFLOW_PLAN_TS, 'utf8')).toContain('REVIEW_INPUT_PORT_NAME')
    // isValidConnection must be reachable so the iterate-lock surface
    // remains wired even if the prop is removed by accident.
    expect(tsx).toContain('isValidConnection')
    // RFC-354: the review card data and the fan-out shard chrome are edge- /
    // field-derived — no v5 PortRef read survives on the canvas.
    expect(tsx).toContain('reviewInputSource(definition, n.id)')
    expect(tsx).not.toMatch(/\.inputSource\b|isShardSource|ensureWrapperFanoutInputForEdge/)
  })

  test('ReviewEdit / OutputEdit / WrapperGitLoopEdit / WrapperFanoutEdit never write a v5 PortRef', () => {
    // RFC-146 T3: the per-kind branches live in inspector/*.tsx. RFC-354:
    // none of them dispatches a mirror transition any more — the only
    // inspector-side graph write is deleting an edge (delete-selection).
    for (const file of [
      'ReviewEdit.tsx',
      'OutputEdit.tsx',
      'WrapperGitLoopEdit.tsx',
      'WrapperFanoutEdit.tsx',
    ]) {
      const tsx = readFileSync(resolve(INSPECTOR_DIR, file), 'utf8')
      expect(tsx, file).not.toMatch(/set-review-input-source|set-output-ports|set-fanout-inputs/)
      expect(tsx, file).not.toMatch(/syncEdgeFromFormField/)
      expect(tsx, file).not.toMatch(/inputSource\s*:|outputBindings\s*:|\bports\s*:|\binputs\s*:/)
    }
    expect(readFileSync(resolve(INSPECTOR_DIR, 'ReviewEdit.tsx'), 'utf8')).toContain(
      "kind: 'delete-selection'",
    )
    expect(readFileSync(resolve(INSPECTOR_DIR, 'OutputEdit.tsx'), 'utf8')).toContain(
      "kind: 'delete-selection'",
    )
    expect(readFileSync(resolve(INSPECTOR_DIR, 'WrapperFanoutEdit.tsx'), 'utf8')).toContain(
      'shardSourcePort',
    )
  })

  test('workflows.edit.tsx upgrades a loaded definition to the latest schema instead of healing mirrors', () => {
    const tsx = readFileSync(WORKFLOWS_EDIT_TSX, 'utf8')
    expect(tsx).toContain('migrateWorkflowDefinitionToLatest')
    expect(tsx).not.toContain('healFieldEdgeConsistency')
  })

  // Visual distinction for the review-node kind now comes from the shared
  // card shell plus a centralized Human-family accent token. Lock both halves
  // so review cannot fall back to an untyped neutral card.
  test('styles.css maps review into the shared amber card family', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toContain('.canvas-node--card {')
    const start = css.indexOf(".canvas-node--card[data-node-kind='review'],")
    expect(start).toBeGreaterThanOrEqual(0)
    const humanAccentGroup = css.slice(start, css.indexOf('}', start) + 1)
    expect(humanAccentGroup).toContain('--node-accent: #d97706;')
    expect(css).toMatch(/\.canvas-node--card \.canvas-node__kind\s*\{[^}]*var\(--node-accent\)/s)
  })
})
