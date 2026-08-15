// RFC-304 §2.2 invariant two — the MR-level lease.
//
// Invariant one (one running round per work item) is not enough to deliver the
// promised "one MR is handled serially": `mr-review` and `mr-monitor` are two
// work items on the same MR, and both can be `running`. When an MR update and a
// pipeline failure arrive together, the monitor is fixing CI and pushing while
// the review round comments on the OLD sha — the author sees remarks on code
// the machine just rewrote.
//
// So a second layer, keyed by the MR itself: any capability must hold this
// lease before opening a round. "Review is independent of the monitor" (E1)
// means their ENTRY POINTS are independent, not that they are separate
// concurrency domains.
//
// The rules that are easy to get backwards, and why they are what they are:
//
//   - the holder is a ROUND, not a work item. A work item outlives many rounds
//     and spends most of its life not running; a lease held by one would be a
//     lease held forever.
//   - `awaiting` and `handed_off` do NOT hold it. Both can last days — waiting
//     for a person, or waiting for someone to take over a failed CI campaign.
//     Holding through them would starve every other capability on that MR.
//     They re-acquire on the way back.
//   - the token carries the daemon GENERATION. After a restart every previously
//     issued token is void, so a lease left behind by a dead daemon cannot
//     block the MR forever, and a zombie writer cannot fence out its successor.

/** Identifies the MR/issue the lease protects. Not the work item, not the round. */
export interface MrLeaseKey {
  codeHostEndpointId: string
  stableProjectId: string
  anchorKind: string
  anchorId: string
}

export interface MrLeaseHolder {
  roundId: string
  /**
   * One-time fencing token: `<daemonGeneration>:<nonce>`. A holder must present
   * it to renew or release, so a round that lost its lease to a takeover cannot
   * release the NEW holder's lease by accident.
   */
  token: string
  /** Renewal deadline; past it the lease is stealable. */
  expiresAt: number
}

export type LeaseAcquisition =
  | { outcome: 'acquired'; holder: MrLeaseHolder }
  /** Someone else holds it and it has not expired — the caller stays queued. */
  | { outcome: 'busy'; heldBy: string; expiresAt: number }

export type LeaseRelease =
  | { outcome: 'released' }
  /** The token does not match the current holder — a stale round tried to release. */
  | { outcome: 'not-holder'; reason: string }

export function leaseKeyOf(key: MrLeaseKey): string {
  // Percent-encode each part before joining, so two different tuples cannot
  // render the same string: without it, an endpoint id containing the delimiter
  // would let one MR's lease answer for another's. `|` is safe as the delimiter
  // precisely because `encodeURIComponent` escapes it inside the parts.
  return [key.codeHostEndpointId, key.stableProjectId, key.anchorKind, key.anchorId]
    .map((part) => encodeURIComponent(part))
    .join('|')
}

/** Build a fencing token bound to this daemon's generation. */
export function mintLeaseToken(daemonGeneration: string, nonce: string): string {
  return `${daemonGeneration}:${nonce}`
}

export function tokenGeneration(token: string): string {
  const idx = token.indexOf(':')
  return idx === -1 ? '' : token.slice(0, idx)
}

/**
 * Decide whether `candidate` may take the lease.
 *
 * Pure so the interesting cases — expiry, takeover, restart — are testable
 * without a clock or a database. The caller performs the CAS.
 */
export function decideLeaseAcquisition(args: {
  current: MrLeaseHolder | null
  candidateRoundId: string
  candidateToken: string
  now: number
  leaseMs: number
  /** This daemon's generation; a holder from an older one is void. */
  daemonGeneration: string
}): LeaseAcquisition {
  const { current } = args
  const grant = (): LeaseAcquisition => ({
    outcome: 'acquired',
    holder: {
      roundId: args.candidateRoundId,
      token: args.candidateToken,
      expiresAt: args.now + args.leaseMs,
    },
  })

  if (current === null) return grant()

  // Re-entrant: the same round re-acquiring (after a resume, say) is not a
  // conflict with itself. Without this a round that re-entered its own critical
  // path would deadlock against its own lease.
  if (current.roundId === args.candidateRoundId) return grant()

  // A holder minted by a previous daemon generation is void regardless of its
  // expiry: that process is gone, and nothing will ever renew or release it.
  if (tokenGeneration(current.token) !== args.daemonGeneration) return grant()

  if (current.expiresAt <= args.now) return grant()

  return { outcome: 'busy', heldBy: current.roundId, expiresAt: current.expiresAt }
}

/**
 * Decide whether a release is legitimate.
 *
 * Token-checked, not round-checked: after a takeover the previous round may
 * still be shutting down, and letting it release by round id alone would drop
 * the NEW holder's lease — handing the MR to a third round while the second is
 * mid-write.
 */
export function decideLeaseRelease(args: {
  current: MrLeaseHolder | null
  token: string
}): LeaseRelease {
  if (args.current === null) {
    // Idempotent: releasing an already-released lease is what a retried
    // shutdown path does, and it should not be an error.
    return { outcome: 'released' }
  }
  if (args.current.token !== args.token) {
    return {
      outcome: 'not-holder',
      reason: `lease is held by round '${args.current.roundId}' under a different token`,
    }
  }
  return { outcome: 'released' }
}

/**
 * Work-item statuses that must NOT hold the lease.
 *
 * Stated as data rather than scattered `if`s so the release path and the
 * "should I still hold this" audit read from one list — the failure mode is a
 * status that holds the lease in one place and is expected not to in another.
 */
export const LEASE_FREE_STATUSES: readonly string[] = ['awaiting', 'handed_off', 'closed']

export function shouldHoldLease(status: string): boolean {
  return !LEASE_FREE_STATUSES.includes(status)
}
