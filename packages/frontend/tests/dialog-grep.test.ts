// RFC-035 PR3 — source-level guard. The three dialog retrofits MUST
// render the shared <Dialog>; their legacy bespoke overlay/panel class
// names MUST be absent from JSX className strings. (CSS class names
// survive in styles.css as a fallback during the cleanup window.)

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

const read = (rel: string): string => readFileSync(path.resolve(SRC, rel), 'utf8')

describe('RFC-035 <Dialog> retrofit grep guard', () => {
  test('AgentImportDialog imports + renders <Dialog>', () => {
    const body = read('components/AgentImportDialog.tsx')
    expect(body.includes("from './Dialog'") || body.includes("from '@/components/Dialog'")).toBe(
      true,
    )
    expect(/<Dialog[\s>]/.test(body)).toBe(true)
  })

  test('AgentImportDialog no longer applies the legacy overlay / panel JSX className', () => {
    const body = read('components/AgentImportDialog.tsx')
    expect(/className="agent-import__overlay/.test(body)).toBe(false)
    expect(/className="agent-import__panel/.test(body)).toBe(false)
    expect(body.includes('panelClassName=')).toBe(false)
    expect(/className="agent-import__header/.test(body)).toBe(false)
    expect(/className="agent-import__footer/.test(body)).toBe(false)
  })

  test('BatchImportDialog imports + renders <Dialog>', () => {
    const body = read('components/repos/BatchImportDialog.tsx')
    expect(body.includes("from '@/components/Dialog'")).toBe(true)
    expect(/<Dialog[\s>]/.test(body)).toBe(true)
  })

  test('BatchImportDialog no longer applies the legacy .modal / .modal-backdrop JSX className', () => {
    const body = read('components/repos/BatchImportDialog.tsx')
    expect(/className="modal-backdrop/.test(body)).toBe(false)
    expect(/className="modal /.test(body)).toBe(false)
    expect(/className="modal__actions/.test(body)).toBe(false)
  })

  test('reviews.detail.tsx imports + renders <Dialog>', () => {
    const body = read('routes/reviews.detail.tsx')
    expect(body.includes("from '@/components/Dialog'")).toBe(true)
    expect(/<Dialog[\s>]/.test(body)).toBe(true)
  })

  test('reviews.detail.tsx no longer applies the legacy review-decision-dialog overlay / actions JSX className', () => {
    const body = read('routes/reviews.detail.tsx')
    expect(/className="review-decision-dialog__overlay/.test(body)).toBe(false)
    expect(/className="review-decision-dialog__actions/.test(body)).toBe(false)
    expect(/className="review-decision-dialog__header/.test(body)).toBe(false)
  })
})
