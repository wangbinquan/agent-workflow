// RFC-007 source-level regression guard. The runtime / JSDOM tests
// (connection-sync.test.ts + canvas-review-output-drag.test.tsx) exercise
// behavior; this file additionally pins the structural contracts that a
// future refactor could erode silently — imports, exported symbols,
// hand-coded sentinel ids.
//
// Pattern follows the [feedback_post_commit_ci_check] "source-code-level
// fallback": JSDOM does not run xyflow's drag-and-drop, and the connect
// path's behavior depends on the WorkflowCanvas hooking the same
// connection-sync entry points the form does. If a refactor removes the
// import, the runtime test would still pass (the old behavior re-emerges
// as a regression) but this file would flag it.
//
// Link: design/RFC-007-canvas-review-output-drag/design.md §8.4

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')

const REVIEW_NODE_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'nodes', 'ReviewNode.tsx')
const CONNECTION_SYNC_TS = resolve(FRONTEND_SRC, 'components', 'canvas', 'connectionSync.ts')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const WORKFLOWS_EDIT_TSX = resolve(FRONTEND_SRC, 'routes', 'workflows.edit.tsx')
const STYLES_CSS = resolve(FRONTEND_SRC, 'styles.css')

describe('RFC-007 source-level guard', () => {
  test('connectionSync.ts exists and exports the four sync helpers + sentinel', () => {
    expect(existsSync(CONNECTION_SYNC_TS)).toBe(true)
    const src = readFileSync(CONNECTION_SYNC_TS, 'utf8')
    expect(src).toMatch(/export const REVIEW_INPUT_HANDLE_ID\s*=\s*['"]__review_input__['"]/)
    expect(src).toMatch(/export function applyConnectionForReviewOutput\b/)
    expect(src).toMatch(/export function applyDisconnectForReviewOutput\b/)
    expect(src).toMatch(/export function syncEdgeFromFormField\b/)
    expect(src).toMatch(/export function healFieldEdgeConsistency\b/)
  })

  test('ReviewNode.tsx renders the named target Handle + drops the old "intentionally off" note', () => {
    const tsx = readFileSync(REVIEW_NODE_TSX, 'utf8')
    expect(tsx).toContain('REVIEW_INPUT_HANDLE_ID')
    expect(tsx).toContain('type="target"')
    // The pre-RFC-007 reasoning must be gone — it claimed the catch-all
    // strip was off, which is no longer the design.
    expect(tsx).not.toContain('Catch-all inbound strip is intentionally off')
  })

  test('WorkflowCanvas.tsx imports and wires the sync helpers', () => {
    const tsx = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(tsx).toMatch(/from\s+['"]\.\/connectionSync['"]/)
    expect(tsx).toContain('applyConnectionForReviewOutput')
    expect(tsx).toContain('applyDisconnectForReviewOutput')
    // isValidConnection must be reachable so the iterate-lock surface
    // remains wired even if the prop is removed by accident.
    expect(tsx).toContain('isValidConnection')
  })

  test('ReviewEdit imports REVIEW_INPUT_HANDLE_ID + uses syncEdgeFromFormField', () => {
    // RFC-146 T3: the review branch moved from the NodeInspector switch to
    // inspector/ReviewEdit.tsx (OutputEdit.tsx carries the other
    // syncEdgeFromFormField call for output-port binds).
    const reviewTsx = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'canvas', 'inspector', 'ReviewEdit.tsx'),
      'utf8',
    )
    expect(reviewTsx).toMatch(/from\s+['"]\.\.\/connectionSync['"]/)
    expect(reviewTsx).toContain('REVIEW_INPUT_HANDLE_ID')
    expect(reviewTsx).toContain('syncEdgeFromFormField')
    const outputTsx = readFileSync(
      resolve(FRONTEND_SRC, 'components', 'canvas', 'inspector', 'OutputEdit.tsx'),
      'utf8',
    )
    expect(outputTsx).toContain('syncEdgeFromFormField')
  })

  test('workflows.edit.tsx threads healFieldEdgeConsistency into healLoadedDefinition', () => {
    const tsx = readFileSync(WORKFLOWS_EDIT_TSX, 'utf8')
    expect(tsx).toMatch(/from\s+['"]@\/components\/canvas\/connectionSync['"]/)
    expect(tsx).toContain('healFieldEdgeConsistency')
  })

  // Visual distinction for the review-node kind: the canvas would otherwise
  // render review/agent/io cards in the same neutral panel color, leaving
  // users to read the small kind label to tell them apart. The CSS gives
  // `.canvas-node--review` an amber tint that matches the ⚖ judgment
  // icon — runtime tests can't assert color (jsdom has no layout/style
  // engine), so lock in the rule at the source level.
  test('styles.css gives .canvas-node--review a dedicated amber tint', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.canvas-node--review\s*\{[^}]*background:[^;]*color-mix/)
    expect(css).toMatch(/\.canvas-node--review\s*\{[^}]*border-color:[^;]*color-mix/)
    expect(css).toMatch(/\.canvas-node--review\s+\.canvas-node__kind\s*\{/)
  })
})
