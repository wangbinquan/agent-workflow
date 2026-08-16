// RFC-304 §6.3 T48/T49 — the requirement's input, and where its questions go.
//
// Two properties carry most of the weight here, and both are about refusing
// rather than coping:
//
//   the budget — a set that does not fit is REPORTED, never truncated. Truncate
//                it and the agent implements two thirds of a requirement,
//                produces a merge request that looks complete, and the missing
//                third surfaces in review or later.
//   the route  — a question goes back where it was asked from (D2), with no
//                fallback. The person who labelled the issue is watching the
//                issue and may not have an account here at all; a question that
//                quietly lands somewhere else is one they never see.
//
// The design gate struck out the "otherwise fall back to the platform" arm
// explicitly, so the refusal cases below are the specification, not caution.

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_DOCUMENT_BUDGET,
  RequirementInputSchema,
  judgeDocumentBudget,
  measureDocuments,
  renderRequirementForPrompt,
  type RequirementInput,
} from '../src/modules/code-capability/domain/requirementInput'
import {
  clarifyMarker,
  issueEntryUsable,
  readClarifyMarker,
  renderClarifyComment,
  routeClarify,
} from '../src/modules/code-capability/domain/clarifyRouting'

const input = (over: Partial<RequirementInput> = {}): RequirementInput => ({
  title: 'Retry logic drops the last attempt',
  body: 'When the third attempt fails the error is swallowed.',
  documents: [],
  ...over,
})

describe('RFC-304 T48 — the input contract', () => {
  test('a requirement with no documents is valid', () => {
    // A bug report is a requirement. Demanding a design document for "the retry
    // loop drops the last attempt" would make the capability unusable for the
    // case it is most obviously useful for.
    const parsed = RequirementInputSchema.safeParse({ title: 'Fix the retry loop' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.documents).toEqual([])
  })

  test('a document set keeps its ORDER', () => {
    // Order is the contract. A set reordered on the way in reads to the agent
    // as a different argument.
    const parsed = RequirementInputSchema.parse({
      title: 'x',
      documents: [
        { name: 'proposal.md', role: 'proposal', content: 'why' },
        { name: 'design.md', role: 'design', content: 'how' },
        { name: 'plan.md', role: 'plan', content: 'when' },
      ],
    })
    expect(parsed.documents.map((d) => d.name)).toEqual(['proposal.md', 'design.md', 'plan.md'])
  })

  test('`role` is free text, not an enum', () => {
    // Every company's document system names these differently; an enum would
    // reject a perfectly good set for using the wrong vocabulary.
    expect(
      RequirementInputSchema.safeParse({
        title: 'x',
        documents: [{ name: 'spec.md', role: '需求说明', content: 'x' }],
      }).success,
    ).toBe(true)
  })

  test('an unmodelled field is rejected', () => {
    expect(RequirementInputSchema.safeParse({ title: 'x', priority: 'urgent' }).success).toBe(false)
  })

  test('a document with no name is rejected', () => {
    // The name is what the agent and the activity view call it. An empty one
    // renders as "document 2 of 3: " and helps nobody.
    expect(
      RequirementInputSchema.safeParse({
        title: 'x',
        documents: [{ name: '', content: 'body' }],
      }).success,
    ).toBe(false)
  })
})

describe('RFC-304 T48 — the size budget', () => {
  test('an ordinary set fits', () => {
    const verdict = judgeDocumentBudget(
      input({ documents: [{ name: 'design.md', content: 'x'.repeat(1000) }] }),
    )
    expect(verdict.fits).toBe(true)
  })

  test('the total counts the issue body as well as the documents', () => {
    // The body IS part of the requirement; excluding it would let a 400k-char
    // issue through with a 1-char document attached.
    const sizes = measureDocuments(
      input({ body: 'abcde', documents: [{ name: 'a.md', content: '123' }] }),
    )
    expect(sizes.totalChars).toBe(8)
  })

  test('an over-budget set is refused, listing every document with its size', () => {
    // The person's next question is "which one do I split?", and a total tells
    // them nothing.
    const big = DEFAULT_DOCUMENT_BUDGET.maxTotalChars
    const verdict = judgeDocumentBudget(
      input({
        documents: [
          { name: 'design.md', content: 'x'.repeat(big) },
          { name: 'plan.md', content: 'y'.repeat(100) },
        ],
      }),
    )

    expect(verdict.fits).toBe(false)
    if (verdict.fits) return
    expect(verdict.message).toContain('design.md')
    expect(verdict.message).toContain('plan.md')
    // And it says what did NOT happen, so nobody goes looking for a half-built MR.
    expect(verdict.message).toContain('Nothing was implemented')
  })

  test('the boundary is inclusive', () => {
    const exact = judgeDocumentBudget(
      input({
        body: '',
        documents: [{ name: 'a.md', content: 'x'.repeat(DEFAULT_DOCUMENT_BUDGET.maxTotalChars) }],
      }),
    )
    expect(exact.fits).toBe(true)
  })

  test('a lone oversized issue body is refused too, and says so readably', () => {
    const verdict = judgeDocumentBudget(input({ body: 'x'.repeat(500_000), documents: [] }))
    expect(verdict.fits).toBe(false)
    if (verdict.fits) return
    expect(verdict.message).toContain('issue body alone')
  })
})

describe('RFC-304 T48 — rendering for the agent', () => {
  test('documents are laid out in order, with their names and roles', () => {
    const rendered = renderRequirementForPrompt(
      input({
        documents: [
          { name: 'proposal.md', role: 'proposal', content: 'why' },
          { name: 'design.md', content: 'how' },
        ],
      }),
    )

    expect(rendered.indexOf('proposal.md')).toBeLessThan(rendered.indexOf('design.md'))
    expect(rendered).toContain('document 1 of 2: proposal.md (proposal)')
    // No role, no empty parentheses.
    expect(rendered).toContain('document 2 of 2: design.md ---')
  })

  test('an empty body contributes no blank section', () => {
    const rendered = renderRequirementForPrompt(input({ body: '   ', documents: [] }))
    expect(rendered.trim()).toBe('# Retry logic drops the last attempt')
  })
})

describe('RFC-304 T49 — where a question goes', () => {
  test('a platform-entered requirement asks on the platform', () => {
    expect(routeClarify({ kind: 'platform' })).toEqual({ route: 'platform' })
  })

  test('an issue-entered requirement asks on the issue', () => {
    expect(
      routeClarify({ kind: 'issue', hasWritebackHandle: true, frameworkSupportsWriteback: true }),
    ).toEqual({ route: 'issue-comment' })
  })

  test('no write-back handle REFUSES — it does not fall back to the platform', () => {
    // The arm the design gate struck out. The person who labelled the issue is
    // watching the issue and may not have an account here; a question that
    // quietly lands elsewhere is one they never see, and the requirement sits
    // awaiting until somebody happens to notice.
    const route = routeClarify({
      kind: 'issue',
      hasWritebackHandle: false,
      frameworkSupportsWriteback: true,
    })
    expect(route.route).toBe('refuse')
    expect(route.route === 'refuse' && route.message).toContain('Nothing was started')
  })

  test('a framework that cannot write back REFUSES too', () => {
    const route = routeClarify({
      kind: 'issue',
      hasWritebackHandle: true,
      frameworkSupportsWriteback: false,
    })
    expect(route.route).toBe('refuse')
    expect(route.route === 'refuse' && route.message).toContain('does not implement writing back')
  })

  test('readiness asks the same question, before anything runs', () => {
    // A cell that reports ready and then refuses at round start has told the
    // operator the opposite of the truth at the only moment they were looking.
    expect(
      issueEntryUsable({
        kind: 'issue',
        hasWritebackHandle: false,
        frameworkSupportsWriteback: true,
      }).usable,
    ).toBe(false)
    expect(
      issueEntryUsable({
        kind: 'issue',
        hasWritebackHandle: true,
        frameworkSupportsWriteback: true,
      }).usable,
    ).toBe(true)
  })
})

describe('RFC-304 T49 — tying an answer to its question', () => {
  test('the marker round-trips', () => {
    const marker = clarifyMarker('R7', 'q1')
    expect(readClarifyMarker(`text\n\n${marker}`)).toEqual({ roundId: 'R7', questionId: 'q1' })
  })

  test('an ordinary comment carries no marker', () => {
    expect(readClarifyMarker('yes, exponential backoff is fine')).toBeNull()
  })

  test('the questions are ONE comment, numbered', () => {
    // Three separate comments on an issue read as three separate demands, and
    // the person answers the last and forgets the others.
    const body = renderClarifyComment('R7', [
      { id: 'q1', text: 'Should the retry back off exponentially?' },
      { id: 'q2', text: 'Is three attempts still right?' },
    ])

    expect(body).toContain('2 things need deciding')
    expect(body).toContain('1. Should the retry back off exponentially?')
    expect(body).toContain('2. Is three attempts still right?')
    expect(readClarifyMarker(body)?.roundId).toBe('R7')
  })

  test('one question reads as one question', () => {
    const body = renderClarifyComment('R7', [{ id: 'q1', text: 'Which timeout?' }])
    expect(body).toContain('one thing needs deciding')
    expect(body).not.toContain('1 things')
  })

  test('the comment says nothing is happening until they reply', () => {
    // Otherwise the requirement looks abandoned rather than waiting.
    const body = renderClarifyComment('R7', [{ id: 'q1', text: 'Which timeout?' }])
    expect(body).toContain('Nothing is being implemented until then')
  })
})
