// RFC-023 PR-B C3 — locks the agent-facing limits on clarify envelope.
//
// Why this is its own spec: design.md §4.1 + §13 single-out the per-question
// option count (2-4) and per-envelope question count (≤ 5) as the
// permissive-truncation contract. Agents that over-emit get sliced; agents
// that under-emit (options < 2, empty questions) get a hard reject. Both
// branches matter for product-level UX, so the file pins the constants and
// the truncation behavior together.
//
// If this goes red:
//   - shared/clarify.parseClarifyEnvelopeBody changed the slice thresholds.
//   - shared/schemas/clarify.ts changed the CLARIFY_MAX_* / CLARIFY_MIN_*
//     constants. (Renames must cascade through the scheduler & UI.)

import { describe, expect, test } from 'bun:test'
import {
  CLARIFY_MAX_OPTIONS_PER_QUESTION,
  CLARIFY_MAX_QUESTIONS,
  CLARIFY_MIN_OPTIONS_PER_QUESTION,
  parseClarifyEnvelopeBody,
} from '@agent-workflow/shared'

describe('clarify option/question caps (RFC-023 C3)', () => {
  test('constants pinned: 5 questions max, 2-4 options per question', () => {
    expect(CLARIFY_MAX_QUESTIONS).toBe(5)
    expect(CLARIFY_MAX_OPTIONS_PER_QUESTION).toBe(4)
    expect(CLARIFY_MIN_OPTIONS_PER_QUESTION).toBe(2)
  })

  test('over-emission of questions truncates to MAX with a warning', () => {
    const body = JSON.stringify({
      questions: Array.from({ length: 7 }, (_, i) => ({
        id: `q${i}`,
        title: `Question ${i}`,
        kind: 'single',
        recommended: false,
        options: ['A', 'B'],
      })),
    })
    const out = parseClarifyEnvelopeBody(body)
    expect(out.body?.questions.length).toBe(5)
    expect(out.warnings.some((w) => w.code === 'clarify-questions-too-many')).toBe(true)
  })

  test('over-emission of options truncates to MAX per-question with warnings', () => {
    const body = JSON.stringify({
      questions: [
        {
          id: 'q',
          title: 'Pick',
          kind: 'multi',
          recommended: false,
          options: ['A', 'B', 'C', 'D', 'E', 'F'],
        },
      ],
    })
    const out = parseClarifyEnvelopeBody(body)
    expect(out.body?.questions[0]?.options.length).toBe(4)
    expect(out.warnings.some((w) => w.code === 'clarify-options-too-many')).toBe(true)
  })

  test('under-emission of options (1 option) is a HARD reject with clarify-options-too-few', () => {
    const body = JSON.stringify({
      questions: [
        {
          id: 'q',
          title: 'Bad',
          kind: 'single',
          recommended: false,
          options: ['only-one'],
        },
      ],
    })
    const out = parseClarifyEnvelopeBody(body)
    expect(out.body).toBeNull()
    expect(out.errors.some((e) => e.code === 'clarify-options-too-few')).toBe(true)
  })

  test('zero-length questions array is a HARD reject', () => {
    const out = parseClarifyEnvelopeBody(JSON.stringify({ questions: [] }))
    expect(out.body).toBeNull()
    expect(out.errors.length).toBeGreaterThan(0)
  })
})
