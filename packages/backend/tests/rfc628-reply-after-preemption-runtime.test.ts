// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the user resumed the case, the lifecycle update caused
// by the employee's own push preempted the step, "observe merge request" went on to readiness, and
// the prepared reply was never posted: the reviewer only ever saw "received, working on it".
//
// RFC-628 lets observe-mr (and observe-approval while the approval is pending) finish the previous
// round from the review-resolution ledger first. These cases run the real runtime, type package and
// platform work items on both database providers (design §6 F1–F6, §3.8): the case is walked to the
// point where the reply or the freeze of an uncommitted repair is next, an event takes the round,
// and the reply still lands exactly once. The last case pins development@11, which keeps the old
// behaviour (the reply is lost), as a guard that the fix stays behind the new revision.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describeEachProvider, type ProviderHarness } from './helpers/eachProvider'
import {
  createRfc628Runtime,
  type Rfc628Round,
  type Rfc628Runtime,
  type Rfc628RuntimeOptions,
} from './helpers/rfc628EmployeeRuntime'

const count = (rounds: readonly Rfc628Round[], workItemRef: string) =>
  rounds.filter((round) => round.workItemRef === workItemRef).length
const indexOf = (rounds: readonly Rfc628Round[], workItemRef: string, from = 0) =>
  rounds.findIndex((round, index) => index >= from && round.workItemRef === workItemRef)

describeEachProvider('RFC-628 reply after preemption on the real runtime', (harness) => {
  const homes: string[] = []
  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
  })
  async function runtime(
    database: ProviderHarness,
    options: Rfc628RuntimeOptions & { readonly reviewMode?: 'code' | 'reply-only' } = {},
  ): Promise<Rfc628Runtime> {
    const home = mkdtempSync(join(tmpdir(), 'rfc628-runtime-'))
    homes.push(home)
    const fixture = await createRfc628Runtime(database, home, options)
    fixture.setReviewMode(options.reviewMode ?? 'code')
    await fixture.launch()
    // Delivery: analyze → freeze → publish → observe → (approval) → wait for MR events.
    await fixture.driveUntilIdle()
    expect(await fixture.caseRow()).toMatchObject({ state: 'waiting', currentWorkItemRef: null })
    return fixture
  }
  /** Review feedback arrives and the employee works on it up to the step that is next. */
  async function reviewUntil(
    fixture: Rfc628Runtime,
    next: 'reply-feedback' | 'prepare-change',
    threads: readonly string[] = ['review-1'],
  ): Promise<number> {
    threads.forEach((threadRef, index) => fixture.host.addThread(threadRef, `${index + 1}:1`))
    await fixture.observeMrEvent('development.review-updated', 'review:initial')
    await fixture.stepUntil(fixture.nextIs(next))
    const ledger = await fixture.ledger()
    expect(ledger?.status).toBe('prepared')
    for (const threadRef of threads) {
      expect(fixture.host.receivedReplies(threadRef)).toHaveLength(1)
      expect(fixture.host.resolvedReplies(threadRef)).toHaveLength(0)
    }
    return (await fixture.rounds()).length
  }
  async function since(fixture: Rfc628Runtime, from: number) {
    return (await fixture.rounds()).slice(from)
  }

  // ------------------------------------------------------------------ F1
  test('F1 reply pending × lifecycle update: the reply is posted once and the ledger is replied', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'reply-feedback')
    const published = (await fixture.ledger())!.publishedHeadSha
    expect(published).toBe(fixture.host.head)
    await fixture.observeMrEvent('development.lifecycle-updated', `lifecycle:${published}`)
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-lifecycle' })
    expect(after[1]).toMatchObject({ workItemRef: 'reply-feedback' })
    expect(count(after, 'reply-feedback')).toBe(1)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-1')[0]!.body).toContain(published!.slice(0, 12))
    expect((await fixture.ledger())?.status).toBe('replied')
    expect(await fixture.caseRow()).toMatchObject({ state: 'waiting' })
  }, 120_000)

  test('F1 reply pending × review update without new feedback: the reply is still posted', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'reply-feedback')
    // The reviewer only resolved the thread; the reply is for the recorded revision and still goes out.
    fixture.host.resolveThread('review-1')
    await fixture.observeMrEvent('development.review-updated', 'review:resolved-only')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-review' })
    expect(count(after, 'reply-feedback')).toBe(1)
    expect(count(after, 'classify-feedback')).toBe(0)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')
  }, 120_000)

  test('F1 reply pending × review update with new feedback: the old reply goes out before the new thread is collected', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'reply-feedback')
    const published = (await fixture.ledger())!.publishedHeadSha!
    // The reviewer opens a second thread before the first one received its repair result.
    fixture.host.addThread('review-2', '7:1')
    await fixture.observeMrEvent('development.review-updated', 'review:new-thread-before-reply')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-review' })
    expect(after[1]).toMatchObject({ workItemRef: 'reply-feedback' })
    const classify = indexOf(after, 'classify-feedback')
    expect(classify).toBeGreaterThan(1)
    expect(count(after, 'classify-feedback')).toBe(1)
    // One reply for the preempted round, one for the round that handled the new thread.
    expect(count(after, 'reply-feedback')).toBe(2)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-1')[0]!.body).toContain(published.slice(0, 12))
    expect(fixture.host.receivedReplies('review-2')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-2')).toHaveLength(1)
    const ledger = (await fixture.ledger())!
    expect(ledger.status).toBe('replied')
    expect(ledger.threads.map((thread) => thread.threadRef).sort()).toEqual([
      'review-1',
      'review-2',
    ])
    expect(ledger.threads.every((thread) => thread.finalReply !== null)).toBe(true)
  }, 120_000)

  test('F1 reply pending × real conflict: repair the conflict, publish it, then reply', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'reply-feedback')
    const published = (await fixture.ledger())!.publishedHeadSha!
    fixture.host.setConflict(true)
    await fixture.observeMrEvent('development.conflict-updated', `conflict:${published}`)
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-conflict' })
    const repair = indexOf(after, 'repair-conflict')
    const publish = indexOf(after, 'publish-conflict', repair)
    const observe = indexOf(after, 'observe-mr', publish)
    const reply = indexOf(after, 'reply-feedback', observe)
    expect(repair).toBeGreaterThan(0)
    expect(publish).toBeGreaterThan(repair)
    expect(observe).toBeGreaterThan(publish)
    expect(reply).toBeGreaterThan(observe)
    expect(count(after, 'reply-feedback')).toBe(1)
    // The reply names the commit the repair was published in, not the later merge commit.
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-1')[0]!.body).toContain(published.slice(0, 12))
    expect((await fixture.ledger())?.status).toBe('replied')
  }, 120_000)

  test('F1 reply pending × pending approval: observe-approval replies first, then observe-mr waits', async () => {
    const fixture = await runtime(harness, { approvalHold: true, reviewMode: 'reply-only' })
    expect(fixture.approvals.submits).toBe(1)
    const from = await reviewUntil(fixture, 'reply-feedback')
    await fixture.observeApprovalEvent('approval:pending-1')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({
      workItemRef: 'observe-approval',
      ruleId: 'handle-approval-update',
    })
    expect(after[1]).toMatchObject({ workItemRef: 'reply-feedback' })
    expect(after[2]).toMatchObject({ workItemRef: 'observe-mr' })
    expect(count(after, 'reply-feedback')).toBe(1)
    // A reply does not move the head: the same head's approval keeps waiting, nothing is resubmitted.
    expect(count(after, 'prepare-approval')).toBe(0)
    expect(count(after, 'submit-approval')).toBe(0)
    expect(fixture.approvals.submits).toBe(1)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')
  }, 120_000)

  // ------------------------------------------------------------------ F2
  test('F2 blocked reply → resume → preempted by a lifecycle update: every thread gets exactly one reply', async () => {
    const fixture = await runtime(harness)
    await reviewUntil(fixture, 'reply-feedback', ['review-1', 'review-2'])
    fixture.host.failReplies('review-2')
    await fixture.driveUntilIdle()
    expect(await fixture.caseRow()).toMatchObject({
      state: 'blocked',
      currentWorkItemRef: 'reply-feedback',
    })
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-2')).toHaveLength(0)
    expect((await fixture.ledger())?.status).toBe('prepared')

    // While the case is blocked someone else pushes; the observer reports the lifecycle change.
    fixture.host.foreignPush()
    fixture.host.failReplies('review-2', false)
    await fixture.observeMrEvent('development.lifecycle-updated', 'lifecycle:foreign-push')
    const from = (await fixture.rounds()).length
    await fixture.resume()
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-lifecycle' })
    expect(count(after, 'reply-feedback')).toBe(1)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-2')).toHaveLength(1)
    const ledger = (await fixture.ledger())!
    expect(ledger.status).toBe('replied')
    expect(ledger.threads.every((thread) => thread.finalReply !== null)).toBe(true)
  }, 120_000)

  // ------------------------------------------------------------------ F3
  test('F3 reply pending × lifecycle update showing merged: the case ends without a reply', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'reply-feedback')
    fixture.host.setState('merged')
    await fixture.observeMrEvent('development.lifecycle-updated', 'lifecycle:merged')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after.map((round) => round.workItemRef)).toEqual(['observe-mr'])
    expect(await fixture.caseRow()).toMatchObject({ state: 'terminal', terminalKind: 'merged' })
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(0)
  }, 120_000)

  // ------------------------------------------------------------------ F4
  test('F4 commit pending × review update with new feedback: commit, push and reply first, then collect the new thread', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'prepare-change')
    const reviewedHead = fixture.host.head
    fixture.host.addThread('review-2', '7:1')
    await fixture.observeMrEvent('development.review-updated', 'review:new-thread')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-review' })
    expect(after[1]).toMatchObject({ workItemRef: 'prepare-change' })
    expect(after[2]).toMatchObject({ workItemRef: 'publish-mr' })
    expect(after[3]).toMatchObject({ workItemRef: 'reply-feedback' })
    expect(indexOf(after, 'classify-feedback')).toBeGreaterThan(3)
    expect(count(after, 'classify-feedback')).toBe(1)
    expect(count(after, 'reply-feedback')).toBe(2)
    expect(fixture.host.head).not.toBe(reviewedHead)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.receivedReplies('review-2')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-2')).toHaveLength(1)
    const ledger = (await fixture.ledger())!
    expect(ledger.status).toBe('replied')
    expect(ledger.threads.map((thread) => thread.threadRef).sort()).toEqual([
      'review-1',
      'review-2',
    ])
    expect(ledger.threads.every((thread) => thread.finalReply !== null)).toBe(true)
  }, 120_000)

  test('F4 commit pending × lifecycle update with the head unchanged: freeze, publish and reply', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'prepare-change')
    const reviewedHead = fixture.host.head
    // A lifecycle update that does not move the head (for example the MR became a draft and back):
    // the workspace is not rebuilt, so the uncommitted repair is still there to be frozen.
    await fixture.observeMrEvent('development.lifecycle-updated', 'lifecycle:head-unchanged')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-lifecycle' })
    expect(after.slice(1, 4).map((round) => round.workItemRef)).toEqual([
      'prepare-change',
      'publish-mr',
      'reply-feedback',
    ])
    expect(count(after, 'prepare-change')).toBe(1)
    expect(count(after, 'reply-feedback')).toBe(1)
    expect(fixture.host.head).not.toBe(reviewedHead)
    const ledger = (await fixture.ledger())!
    expect(ledger.status).toBe('replied')
    expect(ledger.publishedHeadSha).toBe(fixture.host.head)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-1')[0]!.body).toContain(
      fixture.host.head.slice(0, 12),
    )
  }, 120_000)

  test('F4 commit pending × real conflict: commit and reply first; the next conflict update repairs it', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'prepare-change')
    fixture.host.setConflict(true)
    await fixture.observeMrEvent('development.conflict-updated', 'conflict:reviewed-head')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-conflict' })
    expect(after[1]).toMatchObject({ workItemRef: 'prepare-change' })
    expect(after[2]).toMatchObject({ workItemRef: 'publish-mr' })
    expect(after[3]).toMatchObject({ workItemRef: 'reply-feedback' })
    expect(count(after, 'repair-conflict')).toBe(0)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')

    // The push changed the head while the conflict remains: the observer reports it again.
    const second = (await fixture.rounds()).length
    await fixture.observeMrEvent('development.conflict-updated', `conflict:${fixture.host.head}`)
    await fixture.driveUntilIdle()
    const repaired = await since(fixture, second)
    expect(repaired[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-conflict' })
    expect(repaired[1]).toMatchObject({ workItemRef: 'repair-conflict' })
    expect(repaired[2]).toMatchObject({ workItemRef: 'publish-conflict' })
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
  }, 120_000)

  // ------------------------------------------------------------------ F5
  test('F5 pending approval × reply pending: reply, then back to observe-mr', async () => {
    const fixture = await runtime(harness, { approvalHold: true, reviewMode: 'reply-only' })
    const from = await reviewUntil(fixture, 'reply-feedback')
    await fixture.observeApprovalEvent('approval:pending-reply')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after.slice(0, 3).map((round) => round.workItemRef)).toEqual([
      'observe-approval',
      'reply-feedback',
      'observe-mr',
    ])
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')
    expect(fixture.approvals.submits).toBe(1)
  }, 120_000)

  test('F5 pending approval × commit pending: freeze, publish and reply, then approve the new head', async () => {
    const fixture = await runtime(harness, { approvalHold: true })
    const from = await reviewUntil(fixture, 'prepare-change')
    await fixture.observeApprovalEvent('approval:pending-commit')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after.slice(0, 5).map((round) => round.workItemRef)).toEqual([
      'observe-approval',
      'prepare-change',
      'publish-mr',
      'reply-feedback',
      'observe-mr',
    ])
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')
    // The old approval belongs to the old head; the new head gets its own, as after a normal publish.
    expect(count(after, 'prepare-approval')).toBe(1)
    expect(fixture.approvals.submits).toBe(2)
  }, 120_000)

  // ------------------------------------------------------------------ F6
  test('F6 a continuation observe-mr collects an unrecorded open thread once and completes the round', async () => {
    const fixture = await runtime(harness)
    const from = await reviewUntil(fixture, 'reply-feedback')
    // New feedback arrives without a review event reaching the case (the event was consumed earlier).
    fixture.host.addThread('review-2', '9:1')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'reply-feedback' })
    expect(after[1]).toMatchObject({ workItemRef: 'observe-mr' })
    expect(after[2]).toMatchObject({ workItemRef: 'classify-feedback' })
    expect(count(after, 'classify-feedback')).toBe(1)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.receivedReplies('review-2')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-2')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')
    expect(await fixture.caseRow()).toMatchObject({ state: 'waiting' })
  }, 120_000)

  test('F6 a lifecycle update between the reply and its continuation still collects the new thread', async () => {
    const fixture = await runtime(harness)
    await reviewUntil(fixture, 'reply-feedback')
    fixture.host.addThread('review-2', '9:1')
    await fixture.stepUntil(async () => {
      const row = await fixture.caseRow()
      return (
        row.state === 'active' &&
        row.currentWorkItemRef === 'observe-mr' &&
        row.activeRoundId === null &&
        (await fixture.ledger())?.status === 'replied'
      )
    })
    const from = (await fixture.rounds()).length
    await fixture.observeMrEvent('development.lifecycle-updated', `lifecycle:${fixture.host.head}`)
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-lifecycle' })
    expect(after[1]).toMatchObject({ workItemRef: 'classify-feedback' })
    expect(count(after, 'classify-feedback')).toBe(1)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(1)
    expect(fixture.host.resolvedReplies('review-2')).toHaveLength(1)
    expect((await fixture.ledger())?.status).toBe('replied')
  }, 120_000)

  // ------------------------------------------------------------------ frozen revision
  test('development@11 keeps its frozen behaviour: a lifecycle update before the reply drops it', async () => {
    const fixture = await runtime(harness, { legacy: true })
    expect(fixture.typeRef).toEqual({ typeId: 'development', revision: 11 })
    const from = await reviewUntil(fixture, 'reply-feedback')
    await fixture.observeMrEvent('development.lifecycle-updated', 'lifecycle:own-push')
    await fixture.driveUntilIdle()
    const after = await since(fixture, from)
    expect(after[0]).toMatchObject({ workItemRef: 'observe-mr', ruleId: 'handle-lifecycle' })
    expect(count(after, 'reply-feedback')).toBe(0)
    expect(fixture.host.resolvedReplies('review-1')).toHaveLength(0)
    expect((await fixture.ledger())?.status).toBe('prepared')
    expect(await fixture.caseRow()).toMatchObject({ state: 'waiting' })
  }, 120_000)
})
