// RFC-023 bugfix source-level regression guards. The pure helpers in
// clarifyDragHelper.ts are covered by canvas-clarify-drag.test.ts; this
// file additionally pins the structural wiring inside WorkflowCanvas.tsx
// that JSDOM can't easily exercise (xyflow drag-and-drop isn't simulable
// in JSDOM). If a future refactor strips the wiring, the helper tests
// still pass — but the canvas would silently fall back to the catch-all
// edge-creation path and the user-reported bugs (#1 stray feedback edge
// only / #2 forward-drag creates wrong edge / #3 deleting one half
// leaves orphan) would resurface.
//
// Mirror of canvas-fanout-source-port-not-floating.test.ts (RFC-015).
//
// Locks:
//   1. computePorts adds `__clarify__` to agent outputs when an outbound
//      clarify edge exists (so xyflow renders the ask edge).
//   2. handleConnect routes drops via classifyClarifyConnection to
//      applyClarifyReverseDrag (covers both directions in one branch).
//   3. isValidConnection consults classifyClarifyConnection so red-dashed
//      feedback fires for both drag directions.
//   4. commitChange invokes cascadeRemoveClarifyChannel so deleting one
//      half of a clarify channel drops the sibling too.

import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const CLARIFY_HELPER_TS = resolve(FRONTEND_SRC, 'components', 'canvas', 'clarifyDragHelper.ts')

describe('RFC-023 bugfix source-level wiring guard', () => {
  test('clarifyDragHelper.ts exports the new classifier + cascade helpers', () => {
    expect(existsSync(CLARIFY_HELPER_TS)).toBe(true)
    const src = readFileSync(CLARIFY_HELPER_TS, 'utf8')
    expect(src).toMatch(/export function classifyClarifyConnection\b/)
    expect(src).toMatch(/export function cascadeRemoveClarifyChannel\b/)
    expect(src).toMatch(/export function describeClarifyChannelEdge\b/)
  })

  test('WorkflowCanvas.tsx wires classifyClarifyConnection in handleConnect AND isValidConnection', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(src).toContain('classifyClarifyConnection')
    // Must appear at least twice — once in the connect path, once in
    // the validity guard. Use a regex count to lock both occurrences.
    const matches = src.match(/classifyClarifyConnection/g) ?? []
    expect(matches.length).toBeGreaterThanOrEqual(3) // import + 2 callers
  })

  test('WorkflowCanvas.tsx invokes cascadeRemoveClarifyChannel from commitChange', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(src).toContain('cascadeRemoveClarifyChannel')
    // The cascade call must live INSIDE commitChange so EVERY edge-delete
    // path (key, right-click menu, EdgeInspector remove, node-removal
    // cascade) funnels through it.
    const commitIdx = src.indexOf('const commitChange = useCallback')
    expect(commitIdx).toBeGreaterThan(-1)
    const nextDeclarationIdx = src.indexOf('const questionBadgeClickRef', commitIdx)
    expect(nextDeclarationIdx).toBeGreaterThan(commitIdx)
    const commitBlock = src.slice(commitIdx, nextDeclarationIdx)
    expect(commitBlock).toContain('pruneDeletedNodeReferences')
    expect(commitBlock).toContain('cascadeRemoveClarifyChannel')
  })

  test('computePorts backfills outputs from outbound edges so orphan/system ports stay visible', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    // The original RFC-023 bugfix special-cased `__clarify__`. That case is
    // now subsumed by a generalized final pass that backfills ANY port name
    // referenced by an outbound edge but missing from the declared outputs
    // (e.g. frozen task-snapshot edge referencing an output port the live
    // agent has since renamed). Without this loop the edge has no Handle to
    // anchor and xyflow logs "Couldn't create edge for source handle id".
    const fnIdx = src.indexOf('export function computePorts')
    expect(fnIdx).toBeGreaterThan(-1)
    // RFC-060 PR-F: wrapper-fanout case added a deriveWrapperFanoutOutputs
    // block inside the switch; the function body grew so the slice window
    // bumps from 3000 → 4500 to keep the fallback edge-pass at function
    // end inside the slice.
    //
    // 2026-05-24: the RFC-060 §3 boundary-input/output skip comments + the
    // refactor that split the two loops into multi-line conditionals
    // pushed the function past 5000 chars; bump to 5500 to keep the
    // fallback edge-pass inside the slice.
    //
    // 2026-06-04: the review case now DERIVES its outlet via
    // reviewApprovedPortName (inputSource kind → accepted/approved_doc) instead
    // of hard-coding `approved_doc`; that ~25-line block pushed the backfill
    // loop to ~offset 6300. Bump 5500 → 7000 to keep it inside the slice.
    const body = src.slice(fnIdx, fnIdx + 7000)
    expect(body).toMatch(
      /for \(const e of definition\.edges\)[\s\S]*?e\.source\.nodeId === node\.id[\s\S]*?outputs\.push\(e\.source\.portName\)/,
    )
  })
})
