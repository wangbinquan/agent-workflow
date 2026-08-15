// RFC-304 §7.2 — batch publication and its failure path.
//
// "One round posts once" (proposal B10) is easy on the success path and easy to
// lose on the failure path, which is where this module lives. GitLab creates
// each draft note with its own request, so there is a real window in which some
// drafts exist and the publish has not happened. A round that dies in that
// window leaves DRAFTS ON THE MR — visible, attributed to the bot, looking
// exactly like a bot that gave up halfway.
//
// So the decision under test is deliberately not "publish what we have": it is
// delete what we created and fail the round, leaving the MR as if nothing had
// happened. The inversion that would break it (compensating the FAILED ids
// rather than the created ones) deletes nothing and leaves the partial batch on
// display, so it gets its own test.

import { describe, expect, test } from 'bun:test'
import {
  decideBatch,
  hasPartialPublishWindow,
  planBatch,
  type DraftOutcome,
  type PublishableFinding,
} from '../src/modules/code-capability/domain/batchPublish'

const finding = (
  fingerprint: string,
  over: Partial<PublishableFinding> = {},
): PublishableFinding => ({
  fingerprint,
  body: `finding ${fingerprint}`,
  position: { line: 1 },
  ...over,
})

describe('RFC-304 §7.2 — planning a batch', () => {
  test('anchored findings become line comments; unanchored fold into the overview', () => {
    // Proposal B11: a correct remark that merely has nowhere to attach is still
    // worth reading, so it is folded in rather than dropped.
    const plan = planBatch(
      [finding('a'), finding('b', { position: undefined }), finding('c')],
      'Reviewed 3 files.',
    )
    expect(plan.anchored.map((f) => f.fingerprint)).toEqual(['a', 'c'])
    expect(plan.degraded.map((f) => f.fingerprint)).toEqual(['b'])
    expect(plan.overview).toContain('Reviewed 3 files.')
    expect(plan.overview).toContain('finding b')
  })

  test('the overview says WHY the degraded ones are not on a line', () => {
    // Without the heading an author assumes the bot could not tell which line
    // it meant, which is a different (and worse) impression than the truth.
    const plan = planBatch([finding('b', { position: undefined })], 'Summary.')
    expect(plan.overview).toContain('could not be anchored')
    expect(plan.overview).toContain('(1)')
  })

  test('ordering is deterministic — the ledger compares batches across rounds', () => {
    // An unstable order would make identical content look changed and produce
    // spurious "new finding" classifications on the next round.
    const a = planBatch([finding('c'), finding('a'), finding('b')], 's')
    const b = planBatch([finding('b'), finding('c'), finding('a')], 's')
    expect(a.anchored.map((f) => f.fingerprint)).toEqual(['a', 'b', 'c'])
    expect(a.anchored).toEqual(b.anchored)
  })

  test('no degraded findings ⇒ the overview is just the summary', () => {
    const plan = planBatch([finding('a')], 'Reviewed 1 file.')
    expect(plan.overview).toBe('Reviewed 1 file.')
    expect(plan.overview).not.toContain('could not be anchored')
  })

  test('an empty summary still produces a usable overview when something degraded', () => {
    const plan = planBatch([finding('b', { position: undefined })], '   ')
    expect(plan.overview).toContain('could not be anchored')
    expect(plan.overview.startsWith('\n')).toBe(false)
  })
})

describe('RFC-304 §7.2 — deciding after the draft phase', () => {
  test('all drafts landed ⇒ publish them in one call', () => {
    const outcomes: DraftOutcome[] = [
      { fingerprint: 'a', ok: true, draftId: 'd1' },
      { fingerprint: 'b', ok: true, draftId: 'd2' },
    ]
    const d = decideBatch(outcomes)
    expect(d.action).toBe('publish')
    expect(d.action === 'publish' && d.draftIds).toEqual(['d1', 'd2'])
  })

  test('one failure ⇒ delete the drafts that SUCCEEDED, and fail the round', () => {
    // The inversion that breaks it: compensating the failed ids deletes nothing
    // (they were never created) and leaves the partial batch visible on the MR.
    const outcomes: DraftOutcome[] = [
      { fingerprint: 'a', ok: true, draftId: 'd1' },
      { fingerprint: 'b', ok: false, error: '422 invalid position' },
      { fingerprint: 'c', ok: true, draftId: 'd3' },
    ]
    const d = decideBatch(outcomes)
    expect(d.action).toBe('compensate')
    expect(d.action === 'compensate' && d.deleteDraftIds).toEqual(['d1', 'd3'])
    // The failed fingerprints are reported so the round's error names what
    // could not be posted, rather than just "publish failed".
    expect(d.action === 'compensate' && d.failedFingerprints).toEqual(['b'])
  })

  test('the FIRST draft failing still compensates nothing-created correctly', () => {
    const d = decideBatch([{ fingerprint: 'a', ok: false, error: 'boom' }])
    expect(d.action).toBe('compensate')
    expect(d.action === 'compensate' && d.deleteDraftIds).toEqual([])
  })

  test('an empty batch skips the API call entirely', () => {
    // Posting an empty review is a wasted call that can still fail, and it
    // leaves an empty bot comment on the MR.
    expect(decideBatch([]).action).toBe('nothing-to-publish')
  })

  test('every failure compensates — there is no "mostly succeeded" case', () => {
    // B10 holds on the failure path too: the MR must look untouched.
    const outcomes: DraftOutcome[] = Array.from({ length: 10 }, (_, i) => ({
      fingerprint: `f${String(i)}`,
      ok: true as const,
      draftId: `d${String(i)}`,
    }))
    outcomes[9] = { fingerprint: 'f9', ok: false, error: 'rate limited' }
    const d = decideBatch(outcomes)
    expect(d.action).toBe('compensate')
    expect(d.action === 'compensate' && d.deleteDraftIds).toHaveLength(9)
  })
})

describe('RFC-304 §7.2 — provider differences are stated, not assumed', () => {
  test('GitLab has a partial-publish window; GitHub does not', () => {
    // GitHub carries the overview and every comment in ONE request: a failure
    // leaves nothing behind, so there is no compensation to run.
    expect(hasPartialPublishWindow('gitlab')).toBe(true)
    expect(hasPartialPublishWindow('github')).toBe(false)
  })

  test('the GitHub path would otherwise delete draft ids that never existed', () => {
    // Stated as a function rather than "add compensation everywhere to be
    // safe": on GitHub there are no draft ids at all, so a blanket
    // compensation would issue deletes against nothing.
    expect(hasPartialPublishWindow('github')).toBe(false)
  })
})
