// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the case was resumed, an event that declares preemption
// (the lifecycle update caused by the employee's own push) took the round instead, and nothing led
// back to the reply: the reply prepared in the review-resolution ledger was never posted. RFC-628
// lets "observe merge request" finish the previous round from the ledger first.
//
// This file locks the pure rule that reads the ledger (design §3.1, §6 A2): published → reply;
// unpublished while the merge request head still equals the ledger's source head (the repair is still
// in the workspace) → freeze the change again; anything else → no follow-up.
import { describe, expect, test } from 'bun:test'
import { pendingReviewFollowUp } from '@/modules/development-automation/domain/reviewResolutionFollowUp'

const sourceHead = 'a'.repeat(40)
const publishedHead = 'b'.repeat(40)
const movedHead = 'c'.repeat(40)

type Status = 'collected' | 'acknowledged' | 'prepared' | 'replied'

const ledger = (status: Status, publishedHeadSha: string | null, sourceHeadSha = sourceHead) => ({
  status,
  publishedHeadSha,
  sourceHeadSha,
})

describe('RFC-628 pendingReviewFollowUp', () => {
  test('no ledger owes no follow-up', () => {
    expect(pendingReviewFollowUp({ ledger: null, mergeRequestHeadSha: sourceHead })).toBeNull()
  })

  test('collected, acknowledged and replied ledgers owe no follow-up, whatever the head', () => {
    for (const head of [sourceHead, movedHead]) {
      expect(
        pendingReviewFollowUp({ ledger: ledger('collected', null), mergeRequestHeadSha: head }),
      ).toBeNull()
      expect(
        pendingReviewFollowUp({ ledger: ledger('acknowledged', null), mergeRequestHeadSha: head }),
      ).toBeNull()
      expect(
        pendingReviewFollowUp({
          ledger: ledger('replied', publishedHead),
          mergeRequestHeadSha: head,
        }),
      ).toBeNull()
    }
  })

  test('a prepared and published ledger owes the reply, whether or not the head moved since', () => {
    for (const head of [sourceHead, publishedHead, movedHead]) {
      expect(
        pendingReviewFollowUp({
          ledger: ledger('prepared', publishedHead),
          mergeRequestHeadSha: head,
        }),
      ).toBe('reply-feedback')
    }
    // A reply-only round records the head it judged against as published: source and published agree.
    expect(
      pendingReviewFollowUp({
        ledger: ledger('prepared', sourceHead),
        mergeRequestHeadSha: sourceHead,
      }),
    ).toBe('reply-feedback')
  })

  test('a prepared, unpublished ledger with an unchanged head owes freezing the change again', () => {
    expect(
      pendingReviewFollowUp({ ledger: ledger('prepared', null), mergeRequestHeadSha: sourceHead }),
    ).toBe('prepare-change')
  })

  test('a prepared, unpublished ledger whose head moved owes nothing (the workspace was rebuilt)', () => {
    expect(
      pendingReviewFollowUp({ ledger: ledger('prepared', null), mergeRequestHeadSha: movedHead }),
    ).toBeNull()
  })
})
