// RFC-304 §2.2 invariant two — the MR-level lease protocol.
//
// The scenario the lease exists for is concrete: an MR update and a pipeline
// failure land together, so `mr-review` and `mr-monitor` — two separate work
// items on the same MR — both try to run. The monitor fixes CI and pushes while
// the review comments on the old sha, and the author sees remarks on code the
// machine just rewrote. Invariant one cannot prevent this, because these are
// different work items.
//
// Four rules here are easy to write backwards, and each gets a test that says
// what goes wrong if you do:
//
//   holder is a ROUND, not a work item  — a work item outlives many rounds;
//   `awaiting`/`handed_off` do NOT hold — they can last days and would starve
//                                         every other capability on that MR;
//   release is TOKEN-checked            — after a takeover the old round is
//                                         still shutting down and must not drop
//                                         the new holder's lease;
//   the token carries the daemon GEN    — a lease left by a dead daemon must
//                                         not block the MR forever.

import { describe, expect, test } from 'bun:test'
import {
  decideLeaseAcquisition,
  decideLeaseRelease,
  leaseKeyOf,
  mintLeaseToken,
  shouldHoldLease,
  tokenGeneration,
  type MrLeaseHolder,
} from '../src/modules/code-capability/domain/mrLease'

const GEN = 'gen-7'
const NOW = 1_000_000
const LEASE_MS = 30_000

const holder = (over: Partial<MrLeaseHolder> = {}): MrLeaseHolder => ({
  roundId: 'round-a',
  token: mintLeaseToken(GEN, 'n1'),
  expiresAt: NOW + LEASE_MS,
  ...over,
})

const acquire = (current: MrLeaseHolder | null, roundId = 'round-b', now = NOW) =>
  decideLeaseAcquisition({
    current,
    candidateRoundId: roundId,
    candidateToken: mintLeaseToken(GEN, 'n2'),
    now,
    leaseMs: LEASE_MS,
    daemonGeneration: GEN,
  })

describe('RFC-304 — lease key', () => {
  test('the key is the MR, not the work item or the capability', () => {
    // Two capabilities on one MR must collide; that collision IS the invariant.
    const review = leaseKeyOf({
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
    })
    const monitor = leaseKeyOf({
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
    })
    expect(review).toBe(monitor)
  })

  test('different MRs, projects and endpoints do not collide', () => {
    const base = { codeHostEndpointId: 'ep_7', stableProjectId: '41823', anchorKind: 'mr' }
    const keys = new Set([
      leaseKeyOf({ ...base, anchorId: '412' }),
      leaseKeyOf({ ...base, anchorId: '413' }),
      leaseKeyOf({ ...base, stableProjectId: '99', anchorId: '412' }),
      leaseKeyOf({ ...base, codeHostEndpointId: 'ep_8', anchorId: '412' }),
      leaseKeyOf({ ...base, anchorKind: 'issue', anchorId: '412' }),
    ])
    expect(keys.size).toBe(5)
  })

  test('a delimiter inside a component cannot forge another MR’s key', () => {
    // The classic ambiguous-join bug: without per-part encoding, an id
    // containing the delimiter lets one MR's lease answer for another's. Uses
    // the ACTUAL delimiter, so changing it without changing the encoding reds
    // this test.
    const a = leaseKeyOf({
      codeHostEndpointId: 'ep|7',
      stableProjectId: 'x',
      anchorKind: 'mr',
      anchorId: '1',
    })
    const b = leaseKeyOf({
      codeHostEndpointId: 'ep',
      stableProjectId: '7|x',
      anchorKind: 'mr',
      anchorId: '1',
    })
    expect(a).not.toBe(b)
  })

  test('the key contains no control characters', () => {
    // A literal NUL in source is banned repo-wide (RFC-113), and a control
    // character in a key would also make it unreadable in a log line — the one
    // place a stuck lease actually gets diagnosed.
    const key = leaseKeyOf({
      codeHostEndpointId: 'ep_7',
      stableProjectId: '41823',
      anchorKind: 'mr',
      anchorId: '412',
    })
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f]/.test(key)).toBe(false)
  })
})

describe('RFC-304 — acquisition', () => {
  test('a free lease is granted with an expiry', () => {
    const r = acquire(null)
    expect(r.outcome).toBe('acquired')
    expect(r.outcome === 'acquired' && r.holder.expiresAt).toBe(NOW + LEASE_MS)
  })

  test('a live lease held by another round makes the candidate wait', () => {
    const r = acquire(holder())
    expect(r.outcome).toBe('busy')
    // The caller stays `queued`; naming the holder is what makes a stuck MR
    // diagnosable instead of just slow.
    expect(r.outcome === 'busy' && r.heldBy).toBe('round-a')
  })

  test('an EXPIRED lease is stealable — a round that stopped renewing is gone', () => {
    const r = acquire(holder({ expiresAt: NOW - 1 }))
    expect(r.outcome).toBe('acquired')
  })

  test('a lease from a PREVIOUS daemon generation is void regardless of expiry', () => {
    // The restart case. That process no longer exists, so nothing will ever
    // renew or release its lease; without this the MR would be blocked until
    // the expiry elapsed — and with a long lease, for a long time.
    const stale = holder({ token: mintLeaseToken('gen-6', 'n1'), expiresAt: NOW + 10 * LEASE_MS })
    expect(acquire(stale).outcome).toBe('acquired')
  })

  test('the same round re-acquiring its own lease is not a conflict', () => {
    // A resumed round must not deadlock against itself.
    const r = acquire(holder({ roundId: 'round-a' }), 'round-a')
    expect(r.outcome).toBe('acquired')
  })
})

describe('RFC-304 — release is token-checked, not round-checked', () => {
  test('the holder releases its own lease', () => {
    const token = mintLeaseToken(GEN, 'n1')
    expect(decideLeaseRelease({ current: holder({ token }), token }).outcome).toBe('released')
  })

  test('a stale round cannot release the NEW holder’s lease', () => {
    // The failure this prevents: after a takeover, the previous round is still
    // shutting down. Releasing by round id — or unconditionally — would hand
    // the MR to a third round while the second is mid-write.
    const current = holder({ roundId: 'round-b', token: mintLeaseToken(GEN, 'n2') })
    const r = decideLeaseRelease({ current, token: mintLeaseToken(GEN, 'n1') })
    expect(r.outcome).toBe('not-holder')
    expect(r.outcome === 'not-holder' && r.reason).toContain('round-b')
  })

  test('releasing an already-free lease is idempotent, not an error', () => {
    // A retried shutdown path does exactly this.
    expect(decideLeaseRelease({ current: null, token: 'anything' }).outcome).toBe('released')
  })
})

describe('RFC-304 — which statuses hold the lease', () => {
  test('long waits do NOT hold it', () => {
    // `awaiting` waits on a person, `handed_off` waits on someone taking over a
    // failed CI campaign. Both can last days; holding through them would starve
    // every other capability on that MR.
    expect(shouldHoldLease('awaiting')).toBe(false)
    expect(shouldHoldLease('handed_off')).toBe(false)
    expect(shouldHoldLease('closed')).toBe(false)
  })

  test('active statuses hold it', () => {
    for (const status of ['queued', 'running', 'superseding', 'closing']) {
      expect(shouldHoldLease(status)).toBe(true)
    }
  })

  test('token generation is recoverable from the token itself', () => {
    // The recovery sweep reads it off stored rows, with no side table to
    // consult — one less thing that can disagree after a crash.
    expect(tokenGeneration(mintLeaseToken('gen-7', 'abc'))).toBe('gen-7')
    expect(tokenGeneration('malformed')).toBe('')
  })
})
