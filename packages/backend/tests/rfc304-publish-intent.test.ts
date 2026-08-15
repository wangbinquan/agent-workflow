// RFC-304 §7 — recoverable publish intents.
//
// The failure being prevented is user-visible: `publish` succeeds, the daemon
// dies before `ledger` writes the external ids, and the next round's
// reconciliation sees the same findings as "new" and posts them again. The
// author reads every remark twice and concludes the bot is broken.
//
// Recovery cannot guess. Both guesses are wrong in opposite directions —
// "assume sent" silently loses a round's findings, "assume not sent" duplicates
// them — so the plan is always derived from what the remote actually reports.
//
// The partial case is the one a naive implementation gets wrong, and it has its
// own test: it is tempting to resend the whole batch and let the code host
// deduplicate. It will not.

import { describe, expect, test } from 'bun:test'
import {
  isWriteBackComplete,
  planPublishRecovery,
  type PublishIntent,
} from '../src/modules/code-capability/domain/publishIntent'

const intent = (over: Partial<PublishIntent> = {}): PublishIntent => ({
  batchId: 'batch-1',
  roundId: 'round-1',
  epoch: 3,
  state: 'pending',
  fingerprints: ['fp-a', 'fp-b', 'fp-c'],
  externalIds: {},
  ...over,
})

describe('RFC-304 §7 — publish recovery plans', () => {
  test('nothing on the remote ⇒ resend the whole batch', () => {
    const plan = planPublishRecovery(intent(), { present: {} })
    expect(plan.action).toBe('resend')
    expect(plan.action === 'resend' && plan.fingerprints).toEqual(['fp-a', 'fp-b', 'fp-c'])
  })

  test('everything on the remote ⇒ adopt the ids, send nothing', () => {
    // The exact crash window: the call landed, the write-back did not.
    const plan = planPublishRecovery(intent(), {
      present: { 'fp-a': 'note-1', 'fp-b': 'note-2', 'fp-c': 'note-3' },
    })
    expect(plan.action).toBe('adopt')
    expect(plan.action === 'adopt' && plan.externalIds['fp-b']).toBe('note-2')
  })

  test('a PARTIAL batch adopts what exists and resends only the rest', () => {
    // Resending the whole batch here would duplicate `fp-a` — the code host
    // will not dedupe for us, and "post it again and hope" is how the original
    // bug reappears in a new shape.
    const plan = planPublishRecovery(intent(), { present: { 'fp-a': 'note-1' } })
    expect(plan.action).toBe('complete')
    expect(plan.action === 'complete' && plan.adopt).toEqual({ 'fp-a': 'note-1' })
    expect(plan.action === 'complete' && plan.resend).toEqual(['fp-b', 'fp-c'])
  })

  test('a settled batch is left alone', () => {
    const plan = planPublishRecovery(intent({ state: 'settled' }), { present: {} })
    expect(plan.action).toBe('none')
  })

  test('abandoned and compensated batches are left alone, and say which', () => {
    // Distinguishable on purpose: "superseded before it went out" and "went out,
    // failed, cleaned up" look identical in the ledger otherwise, and they lead
    // to different questions when someone is reading the history.
    for (const state of ['abandoned', 'compensated'] as const) {
      const plan = planPublishRecovery(intent({ state }), { present: {} })
      expect(plan.action).toBe('none')
      expect(plan.action === 'none' && plan.reason).toContain(state)
    }
  })

  test('an empty batch needs no work', () => {
    const plan = planPublishRecovery(intent({ fingerprints: [] }), { present: {} })
    // Zero to resend and zero adopted ⇒ `adopt` with an empty map, not
    // `resend` with an empty list: sending an empty batch is a wasted API call
    // that can still fail.
    expect(plan.action).toBe('adopt')
  })

  test('remote entries the intent never claimed are ignored', () => {
    // Another round's comments, or a human's. The plan covers THIS batch's
    // fingerprints only — adopting strangers' ids would attribute someone
    // else's comment to this round's finding.
    const plan = planPublishRecovery(intent({ fingerprints: ['fp-a'] }), {
      present: { 'fp-a': 'note-1', 'fp-zzz': 'note-9' },
    })
    expect(plan.action === 'adopt' && plan.externalIds).toEqual({ 'fp-a': 'note-1' })
  })
})

describe('RFC-304 §7 — write-back completeness', () => {
  test('a settled batch missing ids is detectable', () => {
    // Worse than `pending`: recovery SKIPS a settled batch, so the entries whose
    // ids are missing are exactly the ones the next reconciliation re-posts.
    const half = intent({
      state: 'settled',
      externalIds: { 'fp-a': 'note-1' },
    })
    expect(isWriteBackComplete(half)).toBe(false)
  })

  test('a fully written-back batch passes', () => {
    const full = intent({
      state: 'settled',
      externalIds: { 'fp-a': '1', 'fp-b': '2', 'fp-c': '3' },
    })
    expect(isWriteBackComplete(full)).toBe(true)
  })

  test('an empty batch is trivially complete', () => {
    expect(isWriteBackComplete(intent({ fingerprints: [], state: 'settled' }))).toBe(true)
  })
})
