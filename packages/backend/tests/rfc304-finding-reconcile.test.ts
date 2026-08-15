// RFC-304 §6 T22 — three-set reconciliation and the settle-stale edge.
//
// Both bugs this module exists to prevent were found by design gates on a draft
// that looked reasonable, and both are user-visible disasters rather than
// internal inconsistencies. They are the first two tests here.
//
//   1. `dedupe` + `cleanup-previous`: round 1 reports a problem, the author
//      does not fix it, round 2 finds it again — dedupe skips posting, cleanup
//      resolves round 1's thread, and the MR ends up with NO active remark
//      about a problem that is still in the code.
//   2. Repeating the "no longer present" note every round: on an MR pushed 80
//      times, one thread collects 78 identical notes and the human discussion
//      is buried.
//
// Both are fixed by the same idea — external actions fire on the STATE EDGE,
// not on the state — so the tests are written to fail if that idea is lost.

import { describe, expect, test } from 'bun:test'
import {
  ledgerWriteFor,
  planSettleStale,
  reconcileFindings,
  type CurrentFinding,
  type LedgerFinding,
  type ReconcileAction,
} from '../src/modules/code-capability/domain/findingReconcile'

const cur = (fingerprint: string, anchorLine: number | null = 10): CurrentFinding => ({
  fingerprint,
  anchorLine,
})
const led = (fingerprint: string, over: Partial<LedgerFinding> = {}): LedgerFinding => ({
  fingerprint,
  lifecycle: 'active',
  generation: 1,
  externalId: `note-${fingerprint}`,
  ...over,
})

const kindsOf = (actions: readonly ReconcileAction[]): string[] => actions.map((a) => a.kind)
const find = (actions: readonly ReconcileAction[], fingerprint: string) =>
  actions.find((a) => a.fingerprint === fingerprint)

describe('RFC-304 §6 — the two bugs the design gates found', () => {
  test('an unfixed problem keeps its thread — it is NOT deduped away and resolved', () => {
    // The exact scenario: reported in round 1, ignored, found again in round 2.
    // The old dedupe+cleanup pair left the MR with no active remark at all.
    const { actions } = reconcileFindings([cur('fp-a')], [led('fp-a')])
    expect(kindsOf(actions)).toEqual(['keep'])
    // Not republished (the thread is still there) and NOT settled (the problem
    // is still in the code).
    expect(kindsOf(actions)).not.toContain('settle-stale')
    expect(kindsOf(actions)).not.toContain('publish')
  })

  test('an already-settled finding produces NO external action on later rounds', () => {
    // The 78-identical-notes bug. The row stays `disappeared`; only the FIRST
    // round of absence acts.
    const { actions } = reconcileFindings([], [led('fp-a', { lifecycle: 'disappeared' })])
    expect(kindsOf(actions)).toEqual(['leave-settled'])
    // And it writes nothing, so "when did this last change" stays answerable.
    expect(ledgerWriteFor(actions[0]!)).toBeNull()
  })
})

describe('RFC-304 §6 — the three sets', () => {
  test('present in both ⇒ keep, carrying the current anchor for drift updates', () => {
    const { actions } = reconcileFindings([cur('fp-a', 42)], [led('fp-a')])
    const a = find(actions, 'fp-a')
    expect(a?.kind).toBe('keep')
    expect(a?.kind === 'keep' && a.anchorLine).toBe(42)
  })

  test('present only this round ⇒ publish at generation 1', () => {
    const { actions } = reconcileFindings([cur('fp-new')], [])
    const a = find(actions, 'fp-new')
    expect(a?.kind).toBe('publish')
    expect(a?.kind === 'publish' && a.generation).toBe(1)
  })

  test('present only in the ledger ⇒ settle-stale, once', () => {
    const { actions } = reconcileFindings([], [led('fp-gone')])
    const a = find(actions, 'fp-gone')
    expect(a?.kind).toBe('settle-stale')
    expect(a?.kind === 'settle-stale' && a.externalId).toBe('note-fp-gone')
  })

  test('a disappeared finding that RETURNS is republished under a new generation', () => {
    // Reusing the old thread would read as a reopened-then-forgotten remark:
    // it was already resolved (GitLab) or annotated "no longer present"
    // (GitHub). The unique key carries `generation` precisely for this.
    const { actions } = reconcileFindings(
      [cur('fp-back')],
      [led('fp-back', { lifecycle: 'disappeared', generation: 2 })],
    )
    const a = find(actions, 'fp-back')
    expect(a?.kind).toBe('republish')
    expect(a?.kind === 'republish' && a.generation).toBe(3)
    expect(a?.kind === 'republish' && a.supersedes).toBe(2)
  })

  test('a `reappeared` row absent this round settles like an active one', () => {
    // `reappeared` IS an active generation; treating it as already-settled
    // would leave a live thread open forever.
    const { actions } = reconcileFindings([], [led('fp-x', { lifecycle: 'reappeared' })])
    expect(kindsOf(actions)).toEqual(['settle-stale'])
  })

  test('a mixed round classifies every finding exactly once', () => {
    const { actions } = reconcileFindings(
      [cur('keep-me'), cur('brand-new'), cur('came-back')],
      [
        led('keep-me'),
        led('came-back', { lifecycle: 'disappeared', generation: 1 }),
        led('now-gone'),
        led('long-gone', { lifecycle: 'disappeared' }),
      ],
    )
    expect(actions).toHaveLength(5)
    expect(find(actions, 'keep-me')?.kind).toBe('keep')
    expect(find(actions, 'brand-new')?.kind).toBe('publish')
    expect(find(actions, 'came-back')?.kind).toBe('republish')
    expect(find(actions, 'now-gone')?.kind).toBe('settle-stale')
    expect(find(actions, 'long-gone')?.kind).toBe('leave-settled')
  })

  test('ordering is deterministic across identical inputs', () => {
    const a = reconcileFindings([cur('c'), cur('a')], [led('b')])
    const b = reconcileFindings([cur('a'), cur('c')], [led('b')])
    expect(a.actions).toEqual(b.actions)
  })
})

describe('RFC-304 §6 — settle-stale is provider-specific', () => {
  const stale: Extract<ReconcileAction, { kind: 'settle-stale' }> = {
    kind: 'settle-stale',
    fingerprint: 'fp-a',
    externalId: 'note-1',
  }

  test('GitLab resolves the thread', () => {
    expect(planSettleStale('gitlab', stale, 'gone now')).toEqual({
      kind: 'resolve-thread',
      externalId: 'note-1',
    })
  })

  test('GitHub cannot resolve, so it appends a reply instead', () => {
    // `thread.resolve` is `unsupported` for GitHub in the action registry: REST
    // has no such endpoint, and the GraphQL mutation needs a `PRRT_` node id
    // REST never exposes. Batching an unsupported binding does not make it
    // available, so the honest fallback is a reply.
    const step = planSettleStale('github', stale, 'no longer present in the latest round')
    expect(step.kind).toBe('append-note')
    expect(step.kind === 'append-note' && step.body).toContain('no longer present')
  })

  test('a finding that never had its own thread is skipped, not faked', () => {
    // Overview-only findings (unanchored ones) have no thread to resolve or
    // reply to; issuing a call against a null id would 404 every round.
    const step = planSettleStale('gitlab', { ...stale, externalId: null }, 'x')
    expect(step.kind).toBe('skip')
  })
})

describe('RFC-304 §6 — the ledger write cannot drift from the action', () => {
  test('settling writes `disappeared`, so the edge cannot fire twice', () => {
    // If the row kept its old lifecycle, next round would classify it as active
    // and fire the provider action again — the 78-notes bug by another route.
    expect(ledgerWriteFor({ kind: 'settle-stale', fingerprint: 'a', externalId: 'n' })).toEqual({
      fingerprint: 'a',
      lifecycle: 'disappeared',
    })
  })

  test('republishing records the NEW generation', () => {
    expect(
      ledgerWriteFor({ kind: 'republish', fingerprint: 'a', generation: 3, supersedes: 2 }),
    ).toEqual({ fingerprint: 'a', lifecycle: 'reappeared', generation: 3 })
  })

  test('publishing starts active at its generation', () => {
    expect(ledgerWriteFor({ kind: 'publish', fingerprint: 'a', generation: 1 })).toEqual({
      fingerprint: 'a',
      lifecycle: 'active',
      generation: 1,
    })
  })

  test('keep and leave-settled write nothing', () => {
    expect(ledgerWriteFor({ kind: 'keep', fingerprint: 'a', anchorLine: 1 })).toBeNull()
    expect(ledgerWriteFor({ kind: 'leave-settled', fingerprint: 'a' })).toBeNull()
  })
})
