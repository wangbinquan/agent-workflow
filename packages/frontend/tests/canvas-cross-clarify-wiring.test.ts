// RFC-056 PR-D follow-up — UI bug 2026-05-22:
//   "节点连线无法拖动连接" (cannot drag-connect cross-clarify edges).
//
// Root cause: CROSS_CLARIFY_INPUT_PORT_NAME and CLARIFY_INPUT_PORT_NAME
// both expand to the literal string `'questions'`. WorkflowCanvas's
// isValidConnection had the RFC-023 defensive guard
//
//   if (conn.targetHandle === CLARIFY_INPUT_PORT_NAME ||
//       conn.sourceHandle === CLARIFY_OUTPUT_PORT_NAME) return false
//
// placed BETWEEN the RFC-023 clarify classifier and the RFC-056
// cross-clarify classifier. The RFC-023 classifier returns null for
// cross-clarify drops (target.kind !== 'clarify'), so the defensive
// guard then silently rejected every cross-clarify questioner-reverse
// drop because they all carry targetHandle='questions'.
//
// LOCKS (source-text grep against WorkflowCanvas.tsx + clarifyDragHelper /
// crossClarifyDragHelper):
//   1. classifyCrossClarifyConnection is wired into WorkflowCanvas.tsx
//      (at least 3 references: 1 import + 1 handleConnect + 1 isValidConnection).
//   2. In isValidConnection, classifyCrossClarifyConnection MUST appear
//      BEFORE the defensive guard `conn.targetHandle === CLARIFY_INPUT_PORT_NAME`.
//      If a refactor reorders these the bug resurfaces immediately.
//   3. crossClarifyDragHelper.ts exports the 3 helpers WorkflowCanvas relies on.
//
// If any of these go red the canvas drag UX has regressed; investigate
// before relaxing.

import { describe, expect, test } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const FRONTEND_SRC = resolve(__dirname, '..', 'src')
const WORKFLOW_CANVAS_TSX = resolve(FRONTEND_SRC, 'components', 'canvas', 'WorkflowCanvas.tsx')
const CROSS_CLARIFY_HELPER_TS = resolve(
  FRONTEND_SRC,
  'components',
  'canvas',
  'crossClarifyDragHelper.ts',
)

describe('RFC-056 cross-clarify canvas wiring', () => {
  test('crossClarifyDragHelper.ts exports the classifier + apply helpers', () => {
    expect(existsSync(CROSS_CLARIFY_HELPER_TS)).toBe(true)
    const src = readFileSync(CROSS_CLARIFY_HELPER_TS, 'utf8')
    expect(src).toMatch(/export function classifyCrossClarifyConnection\b/)
    expect(src).toMatch(/export function applyCrossClarifyQuestionerReverseDrag\b/)
    expect(src).toMatch(/export function applyCrossClarifyDesignerDrag\b/)
  })

  test('WorkflowCanvas.tsx wires classifyCrossClarifyConnection in handleConnect AND isValidConnection', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    expect(src).toContain('classifyCrossClarifyConnection')
    const matches = src.match(/classifyCrossClarifyConnection/g) ?? []
    // import + handleConnect call + isValidConnection call → ≥ 3
    expect(matches.length).toBeGreaterThanOrEqual(3)
  })

  test('isValidConnection runs classifyCrossClarifyConnection BEFORE the CLARIFY_INPUT_PORT_NAME defensive guard (cross-clarify reuses targetHandle="questions")', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    const isValidIdx = src.indexOf('const isValidConnection = useCallback')
    expect(isValidIdx).toBeGreaterThan(-1)
    // Window into the isValidConnection function body. The closure is
    // ~80 lines long; a 6000-char window covers it without trailing into
    // useCallback's deps array.
    const body = src.slice(isValidIdx, isValidIdx + 6000)
    const crossClassifyIdx = body.indexOf('classifyCrossClarifyConnection(definition')
    const defensiveGuardIdx = body.indexOf('conn.targetHandle === CLARIFY_INPUT_PORT_NAME')
    expect(crossClassifyIdx).toBeGreaterThan(-1)
    expect(defensiveGuardIdx).toBeGreaterThan(-1)
    // The cross-clarify classifier must come FIRST so it can claim drops
    // that share the literal port name 'questions' with RFC-023 clarify.
    expect(crossClassifyIdx).toBeLessThan(defensiveGuardIdx)
  })

  test('isValidConnection covers all 4 cross-clarify system port handles in its defensive guard', () => {
    const src = readFileSync(WORKFLOW_CANVAS_TSX, 'utf8')
    // CROSS_CLARIFY_INPUT_PORT_NAME ('questions') / OUT_TO_QUESTIONER ('to_questioner')
    // / OUT_TO_DESIGNER ('to_designer') / EXTERNAL_FEEDBACK ('__external_feedback__')
    // — all four must reach the defensive guard so a stray drop with one
    // of these handles can't fall through to the generic catch-all that
    // would mint a junk edge.
    expect(src).toContain('CROSS_CLARIFY_INPUT_PORT_NAME')
    expect(src).toContain('CROSS_CLARIFY_OUT_TO_QUESTIONER_PORT')
    expect(src).toContain('CROSS_CLARIFY_OUT_TO_DESIGNER_PORT')
    expect(src).toContain('CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT')
  })

  test('palette label carries an icon prefix in both i18n bundles', () => {
    // UI bug 2026-05-22 issue 1: cross-clarify palette item had no emoji
    // prefix, making it look orphaned next to `⚖ Review node` / `⚡ Clarify`.
    // This grep locks the icon — if someone strips the emoji to make the
    // label "cleaner", this test catches it.
    const EN_TS = resolve(FRONTEND_SRC, 'i18n', 'en-US.ts')
    const ZH_TS = resolve(FRONTEND_SRC, 'i18n', 'zh-CN.ts')
    const en = readFileSync(EN_TS, 'utf8')
    const zh = readFileSync(ZH_TS, 'utf8')
    expect(en).toContain("paletteLabel: '⚡ Cross Clarify'")
    expect(zh).toContain("paletteLabel: '⚡ 跨 agent 反问'")
  })

  test('styles.css declares .canvas-node--clarify-cross-agent matching the clarify family palette', () => {
    // UI bug 2026-05-22 issue 3: cross-clarify on canvas rendered with no
    // amber/gold tint because the CSS class was never declared. The fix
    // adds the rule mirroring `.canvas-node--clarify`. This guard locks
    // both the kind-tint rule AND the kind-text rule so a future refactor
    // can't accidentally drop one half.
    const STYLES_CSS = resolve(FRONTEND_SRC, 'styles.css')
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.canvas-node--clarify-cross-agent\s*\{/)
    expect(css).toMatch(/\.canvas-node--clarify-cross-agent\s+\.canvas-node__kind\s*\{/)
  })
})
