// RFC-304 §6.1 — the contract the `review` stage holds the model to.
//
// The tests split along the line the module exists to draw: which bad answers
// are worth re-asking for, and which are legitimate answers that merely cannot
// be anchored. Both directions of that mistake are expensive —
//
//   too strict: a reviewer that mentions a caller in a neighbouring file gets
//               retried until the budget runs out, and the round fails for
//               having had a thought;
//   too loose:  the platform publishes an empty comment on line 0.
//
// The single most consequential rule here is the one that is NOT a constraint:
// `findings` has no minimum length, because a schema that demands at least one
// finding teaches the model to invent one, and an invented finding is
// indistinguishable from a real one at every stage after this.

import { describe, expect, test } from 'bun:test'
import {
  checkReviewSemantics,
  ReviewEnvelopeSchema,
  type ReviewEnvelope,
} from '../src/modules/code-capability/domain/reviewEnvelope'

const finding = (over: Record<string, unknown> = {}) => ({
  file: 'src/a.ts',
  line: 12,
  severity: 'major',
  title: 'unchecked index',
  body: 'This can be undefined when the list is empty.',
  ...over,
})

const envelope = (findings: unknown[]): ReviewEnvelope =>
  ReviewEnvelopeSchema.parse({ findings }) as ReviewEnvelope

describe('RFC-304 — the review envelope schema', () => {
  test('a well-formed finding parses and defaults to the new side', () => {
    const parsed = envelope([finding()])
    expect(parsed.findings[0]).toMatchObject({ file: 'src/a.ts', line: 12, side: 'new' })
  })

  test('an empty findings list is VALID', () => {
    // A review that found nothing is a real and common answer. Requiring at
    // least one finding is how a platform teaches its model to make things up.
    expect(() => envelope([])).not.toThrow()
  })

  test('line 0 is rejected — git has no line 0', () => {
    expect(() => envelope([finding({ line: 0 })])).toThrow()
  })

  test('a negative line is rejected', () => {
    expect(() => envelope([finding({ line: -3 })])).toThrow()
  })

  test('a fractional line is rejected rather than silently floored', () => {
    // Every host API would take 12.5 and do something with it; which something
    // varies by host, and none of them is what the reviewer meant.
    expect(() => envelope([finding({ line: 12.5 })])).toThrow()
  })

  test('an unknown severity is rejected', () => {
    expect(() => envelope([finding({ severity: 'catastrophic' })])).toThrow()
  })

  test('an empty title or body is rejected', () => {
    expect(() => envelope([finding({ title: '' })])).toThrow()
    expect(() => envelope([finding({ body: '' })])).toThrow()
  })

  test('extra keys are rejected rather than dropped', () => {
    // A model that invents a `confidence` field is answering a different
    // contract; silently dropping it hides the drift until the field is one the
    // platform would have wanted.
    expect(() => envelope([finding({ confidence: 0.9 })])).toThrow()
  })

  test('the old side can be named explicitly', () => {
    const parsed = envelope([finding({ side: 'old' })])
    expect(parsed.findings[0]?.side).toBe('old')
  })
})

describe('RFC-304 — what a retry can plausibly fix', () => {
  test('a clean envelope has no complaints', () => {
    expect(checkReviewSemantics(envelope([finding()]))).toEqual([])
  })

  test('the same finding twice is rejected', () => {
    // Left unfixed, this publishes the identical comment two or three times on
    // one line, which reads as a malfunction rather than as a review.
    const problems = checkReviewSemantics(envelope([finding(), finding()]))
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('src/a.ts:12')
  })

  test('a duplicate is reported once no matter how many times it repeats', () => {
    // Three copies is one problem to fix, not two. Feedback that repeats itself
    // reads as noise and the model starts skimming it.
    expect(checkReviewSemantics(envelope([finding(), finding(), finding()]))).toHaveLength(1)
  })

  test('the same line with a different point is NOT a duplicate', () => {
    const problems = checkReviewSemantics(
      envelope([finding(), finding({ title: 'missing await' })]),
    )
    expect(problems).toEqual([])
  })

  test('the same title on a different line is NOT a duplicate', () => {
    const problems = checkReviewSemantics(envelope([finding(), finding({ line: 40 })]))
    expect(problems).toEqual([])
  })

  test('a title containing the field separator does not forge a duplicate', () => {
    // The dedup key encodes rather than joins. A joined key needs a separator
    // that cannot appear in any field, and a review title can contain anything
    // — so `file="a", title="b"` and `file="a<sep>b", title=""` would collide
    // and one real finding would be dropped as a repeat of another.
    const problems = checkReviewSemantics(
      envelope([
        finding({ file: 'src/a.ts', title: 'x' }),
        finding({ file: 'src/a.ts", "new", 12, "x', title: 'y' }),
      ]),
    )
    expect(problems).toEqual([])
  })

  test('dedup ignores case and surrounding space in the title', () => {
    const problems = checkReviewSemantics(
      envelope([finding(), finding({ title: '  Unchecked Index  ' })]),
    )
    expect(problems).toHaveLength(1)
  })

  test('whitespace-only title or body is caught past the schema', () => {
    // `.min(1)` accepts a single space; a comment whose body is one space is
    // exactly as useless as an empty one.
    expect(checkReviewSemantics(envelope([finding({ body: '   ' })]))).toHaveLength(1)
    expect(checkReviewSemantics(envelope([finding({ title: '  ' })]))).toHaveLength(1)
  })

  test('an absolute path is a formatting slip worth re-asking about', () => {
    // A diff is entirely repo-relative, so an absolute path degrades every time
    // — for a reason the model can trivially correct.
    const problems = checkReviewSemantics(envelope([finding({ file: '/Users/me/src/a.ts' })]))
    expect(problems[0]).toContain('relative to the repository root')
  })

  test('complaints are phrased for the model, not for a log', () => {
    // They go back verbatim as the retry's feedback. A code is not an
    // instruction, and the retry is the whole reason this text exists.
    const problems = checkReviewSemantics(envelope([finding(), finding()]))
    expect(problems[0]).toMatch(/report each distinct problem/)
    expect(problems[0]).not.toMatch(/^[A-Z_]+$/)
  })
})

describe('RFC-304 — what is NOT a semantic problem', () => {
  test('a finding on a file outside the diff passes validation', () => {
    // It degrades at `resolve-positions` (AC-4) instead. Rejecting it here
    // would retry the model for making a legitimate point about code it read as
    // context, and eventually fail the round for it.
    expect(checkReviewSemantics(envelope([finding({ file: 'src/untouched.ts' })]))).toEqual([])
  })

  test('a line far outside any hunk passes validation', () => {
    expect(checkReviewSemantics(envelope([finding({ line: 99999 })]))).toEqual([])
  })

  test('an empty review passes validation', () => {
    expect(checkReviewSemantics(envelope([]))).toEqual([])
  })
})
