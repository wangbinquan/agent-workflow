// RFC-304 §6.1 — the wording of the review request, as a testable artifact.
//
// Prompt text is usually left untested because "it's just a string". These
// particular strings decide whether the platform publishes real findings or
// manufactured ones, so a few of them are locked here.
//
// The load-bearing one is the permission to find nothing. A model asked to
// review will produce findings; asked to review and told that an empty answer
// is complete, it will sometimes return none. The difference between those two
// prompts is the difference between a reviewer people trust and one whose
// comments they learn to skim.

import { describe, expect, test } from 'bun:test'
import { buildReviewPrompt } from '../src/modules/code-capability/domain/reviewPrompt'
import { parseDiffHunks } from '../src/modules/code-capability/domain/diffHunks'

const DIFF = `--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 context
-removed
+added
 context2
`

const base = () => ({
  unifiedDiff: DIFF,
  hunks: parseDiffHunks(DIFF),
  omitted: [],
  mrTitle: 'Add retry logic',
})

describe('RFC-304 — what the review prompt guarantees', () => {
  test('finding nothing is stated to be a complete answer', () => {
    // Without this sentence the model invents a finding to have something to
    // say, and an invented finding is indistinguishable from a real one at
    // every stage after this.
    const { prompt } = buildReviewPrompt(base())
    expect(prompt).toContain('report no findings at all')
    expect(prompt).toMatch(/do NOT manufacture a finding/i)
  })

  test('the changed files are named so remarks land where they can anchor', () => {
    const { prompt } = buildReviewPrompt(base())
    expect(prompt).toContain('src/a.ts')
  })

  test('the diff itself is included', () => {
    const { prompt } = buildReviewPrompt(base())
    expect(prompt).toContain('@@ -10,3 +10,4 @@')
  })

  test('the MR title is included when there is one', () => {
    expect(buildReviewPrompt(base()).prompt).toContain('Add retry logic')
  })

  test('no title is simply omitted, not rendered as null', () => {
    const { prompt } = buildReviewPrompt({ ...base(), mrTitle: null })
    expect(prompt).not.toContain('null')
    expect(prompt).not.toContain('titled:')
  })

  test('a whitespace-only title is treated as absent', () => {
    const { prompt } = buildReviewPrompt({ ...base(), mrTitle: '   ' })
    expect(prompt).not.toContain('titled:')
  })
})

describe('RFC-304 — files the diff could not carry', () => {
  test('omitted files are named with why', () => {
    // Otherwise the model reasons about an MR it believes is smaller than it
    // is, and may confidently conclude a change is safe because it never saw
    // the file that makes it unsafe.
    const { prompt } = buildReviewPrompt({
      ...base(),
      omitted: [
        { path: 'img.png', omission: 'binary' },
        { path: 'dist/bundle.js', omission: 'too-large' },
      ],
    })
    expect(prompt).toContain('img.png (binary)')
    expect(prompt).toContain('dist/bundle.js (too large')
  })

  test('with nothing omitted the section is absent entirely', () => {
    const { prompt } = buildReviewPrompt(base())
    expect(prompt).not.toContain('their contents are not in the diff')
  })
})

describe('RFC-304 — an over-length diff is clipped VISIBLY', () => {
  const long = () => ({
    ...base(),
    unifiedDiff: `${DIFF}${'x'.repeat(500)}`,
    budgetChars: 100,
  })

  test('clipping is reported to the caller', () => {
    // The overview comment has to say the review was partial; a silent clip
    // produces a review that reads as complete and covers a prefix.
    expect(buildReviewPrompt(long()).diffClipped).toBe(true)
  })

  test('clipping is stated in the prompt as well', () => {
    // The model is the other party that would otherwise conclude, wrongly, that
    // it has seen the whole change.
    const { prompt } = buildReviewPrompt(long())
    expect(prompt).toContain('clipped')
    expect(prompt).toContain('do not guess at the rest')
  })

  test('a diff within budget is not marked clipped', () => {
    expect(buildReviewPrompt(base()).diffClipped).toBe(false)
    expect(buildReviewPrompt(base()).prompt).not.toContain('clipped')
  })

  test('the clip keeps the beginning of the diff, not the end', () => {
    const { prompt } = buildReviewPrompt(long())
    expect(prompt).toContain('--- a/src/a.ts')
  })
})

describe('RFC-304 — a diff with nothing readable', () => {
  test('an empty diff says so rather than listing no files and moving on', () => {
    // This round is legitimate (an MR whose only change is a binary). Telling
    // the model plainly beats handing it an empty bullet list.
    const { prompt } = buildReviewPrompt({
      unifiedDiff: '',
      hunks: [],
      omitted: [{ path: 'img.png', omission: 'binary' }],
      mrTitle: null,
    })
    expect(prompt).toContain('changes no readable lines')
    expect(prompt).toContain('img.png')
  })
})
