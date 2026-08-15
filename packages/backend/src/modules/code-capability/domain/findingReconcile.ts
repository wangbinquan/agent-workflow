// RFC-304 §6 — reconciling this round's findings against the ledger.
//
// The first draft was `dedupe` (same fingerprint ⇒ do not repost) plus
// `cleanup-previous` (resolve last round's open threads). Two design gates
// showed that combination LOSES FEEDBACK in the case that matters most:
//
//   round 1 reports a problem → the author does not fix it → round 2 finds it
//   again → dedupe skips posting (same fingerprint) → cleanup-previous resolves
//   round 1's thread → the problem is still in the code and the MR now has no
//   active remark about it at all.
//
// So: reconcile against THREE sets, and move cleanup to after a successful
// publish. And model the finding's lifecycle explicitly, because the two holes
// the gates found are both "an action repeated when it should have fired once":
//
//   active ──not seen this round──► disappeared ──seen again──► reappeared
//
// External actions fire ONLY on the edge. Without that:
//   - a disappeared-then-returned problem reads as "still there" (a ledger row
//     exists ⇒ do not repost), so the live problem has no active thread;
//   - GitHub gets one "no longer present" reply EVERY round — on an MR pushed
//     80 times, the same thread collects 78 identical notes and buries the
//     actual human discussion.

export type FindingLifecycle = 'active' | 'disappeared' | 'reappeared'

export interface LedgerFinding {
  fingerprint: string
  lifecycle: FindingLifecycle
  /** Bumped when a disappeared finding comes back; the unique key includes it. */
  generation: number
  /** The code host's id for the thread this finding owns, when published. */
  externalId: string | null
}

export interface CurrentFinding {
  fingerprint: string
  /** Null when this round could not anchor it (it rides the overview instead). */
  anchorLine: number | null
}

export type ReconcileAction =
  /**
   * Present in both, and the ledger row is active. Do NOT repost, and do NOT
   * resolve the existing thread — the problem is still there. Refresh
   * `lastSeenAt`, and update the anchor if the line drifted.
   */
  | { kind: 'keep'; fingerprint: string; anchorLine: number | null }
  /** Not in the ledger at all — publish it. */
  | { kind: 'publish'; fingerprint: string; generation: number }
  /**
   * In the ledger as `disappeared`, and back this round. Publish under a NEW
   * generation and terminate the old row: its thread was already resolved or
   * annotated, so reusing it would read as a reopened-then-forgotten remark.
   */
  | { kind: 'republish'; fingerprint: string; generation: number; supersedes: number }
  /**
   * Active in the ledger, absent this round. This is the EDGE — the provider
   * action fires exactly once, here.
   */
  | { kind: 'settle-stale'; fingerprint: string; externalId: string | null }
  /**
   * Already `disappeared` and still absent. No external action: this is the
   * repetition that produced 78 identical notes.
   */
  | { kind: 'leave-settled'; fingerprint: string }

export interface ReconcileResult {
  actions: readonly ReconcileAction[]
}

/**
 * Reconcile one round's findings against the ledger.
 *
 * Only `active` ledger rows count as "still present" (design §6): treating a
 * `disappeared` row as present would classify a long-gone problem as
 * "continuing" and suppress the republish that should happen when it returns.
 */
export function reconcileFindings(
  current: readonly CurrentFinding[],
  ledger: readonly LedgerFinding[],
): ReconcileResult {
  const byFingerprint = new Map(ledger.map((l) => [l.fingerprint, l]))
  const seen = new Set(current.map((c) => c.fingerprint))
  const actions: ReconcileAction[] = []

  for (const finding of [...current].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))) {
    const row = byFingerprint.get(finding.fingerprint)
    if (row === undefined) {
      actions.push({ kind: 'publish', fingerprint: finding.fingerprint, generation: 1 })
      continue
    }
    if (row.lifecycle === 'disappeared') {
      actions.push({
        kind: 'republish',
        fingerprint: finding.fingerprint,
        generation: row.generation + 1,
        supersedes: row.generation,
      })
      continue
    }
    actions.push({ kind: 'keep', fingerprint: finding.fingerprint, anchorLine: finding.anchorLine })
  }

  for (const row of [...ledger].sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : 1))) {
    if (seen.has(row.fingerprint)) continue
    if (row.lifecycle === 'disappeared') {
      actions.push({ kind: 'leave-settled', fingerprint: row.fingerprint })
      continue
    }
    // `active` or `reappeared` (which IS an active generation) → the edge.
    actions.push({ kind: 'settle-stale', fingerprint: row.fingerprint, externalId: row.externalId })
  }

  return { actions }
}

export type SettleStaleStep =
  /** GitLab can mark the discussion resolved. */
  | { kind: 'resolve-thread'; externalId: string }
  /**
   * GitHub cannot resolve: `thread.resolve` is `unsupported` for it in the
   * action registry (REST has no such endpoint; the GraphQL mutation needs a
   * `PRRT_` node id REST never exposes). Batching an unsupported binding does
   * not make it available — so the honest fallback is one reply saying the
   * finding is gone.
   */
  | { kind: 'append-note'; externalId: string; body: string }
  /** Nothing was ever published for this finding, so nothing to settle. */
  | { kind: 'skip'; reason: string }

/**
 * What settling one stale finding means on this host.
 *
 * Called ONLY for `settle-stale` actions — the edge. Calling it for every
 * absent finding every round is exactly the bug that buried MR discussions
 * under repeated notes.
 */
export function planSettleStale(
  provider: 'gitlab' | 'github',
  action: Extract<ReconcileAction, { kind: 'settle-stale' }>,
  noteBody: string,
): SettleStaleStep {
  if (action.externalId === null) {
    // A finding that only ever rode the overview has no thread of its own.
    return { kind: 'skip', reason: 'finding was never published as its own thread' }
  }
  return provider === 'gitlab'
    ? { kind: 'resolve-thread', externalId: action.externalId }
    : { kind: 'append-note', externalId: action.externalId, body: noteBody }
}

/**
 * The ledger writes implied by a reconcile action.
 *
 * Derived here rather than at the call site so the lifecycle can never drift
 * from the external action: an `active → disappeared` row that kept its old
 * lifecycle would fire the provider action again next round.
 */
export function ledgerWriteFor(
  action: ReconcileAction,
): { fingerprint: string; lifecycle: FindingLifecycle; generation?: number } | null {
  switch (action.kind) {
    case 'settle-stale':
      return { fingerprint: action.fingerprint, lifecycle: 'disappeared' }
    case 'republish':
      return {
        fingerprint: action.fingerprint,
        lifecycle: 'reappeared',
        generation: action.generation,
      }
    case 'publish':
      return {
        fingerprint: action.fingerprint,
        lifecycle: 'active',
        generation: action.generation,
      }
    case 'keep':
    case 'leave-settled':
      // No lifecycle change. Writing the same value back would be harmless but
      // would also make "when did this last change" unanswerable.
      return null
  }
}
