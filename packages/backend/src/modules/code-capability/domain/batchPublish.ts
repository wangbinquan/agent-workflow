// RFC-304 §7.2 — batch publication, and what happens when half of it fails.
//
// The product rule is "one round posts once" (proposal B10), and it has to hold
// on the FAILURE path too, which is where it usually gets lost. The two hosts
// make that easy and hard respectively:
//
//   GitHub  one POST carries the overview and every line comment. It either
//           lands whole or not at all — no partial state is representable.
//   GitLab  each draft note is its own POST, then one bulk_publish. So there IS
//           a window where some drafts exist and the publish has not happened.
//
// GitLab's window is the whole reason this module exists. A round preempted or
// failed inside it leaves DRAFTS ON THE MR — visible to the author, attributed
// to the bot, and looking exactly like a bot that gave up halfway. So a partial
// failure is not "publish what we have": it is delete what we created and fail
// the round, leaving the MR as if nothing happened.
//
// Findings that could not be anchored are NOT dropped — they fold into the
// overview body (proposal B11). A correct remark that merely has nowhere to
// attach is still worth reading.

export interface PublishableFinding {
  /** Stable identity for the ledger and for recovery reconciliation. */
  fingerprint: string
  body: string
  /** Absent ⇒ this finding could not be anchored and belongs in the overview. */
  position?: unknown
}

export interface BatchPlan {
  /** Findings that will become line comments, in deterministic order. */
  anchored: readonly PublishableFinding[]
  /** Findings folded into the overview because they could not be anchored. */
  degraded: readonly PublishableFinding[]
  /** The overview comment: summary plus every degraded finding. */
  overview: string
}

/**
 * Split findings into line comments and overview content.
 *
 * Deterministic order: the ledger's reconciliation compares batches across
 * rounds, and an unstable order would make identical content look changed.
 */
export function planBatch(findings: readonly PublishableFinding[], summary: string): BatchPlan {
  const anchored = findings.filter((f) => f.position !== undefined)
  const degraded = findings.filter((f) => f.position === undefined)
  const sortByFingerprint = (a: PublishableFinding, b: PublishableFinding): number =>
    a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0

  const parts = [summary.trim()].filter((s) => s.length > 0)
  if (degraded.length > 0) {
    // Named explicitly rather than silently appended: an author reading these
    // needs to know WHY they are not on a line, or they will assume the bot
    // could not tell which line it meant.
    parts.push(
      `### Findings that could not be anchored to a line (${String(degraded.length)})`,
      ...[...degraded].sort(sortByFingerprint).map((f) => `- ${f.body}`),
    )
  }

  return {
    anchored: [...anchored].sort(sortByFingerprint),
    degraded: [...degraded].sort(sortByFingerprint),
    overview: parts.join('\n\n'),
  }
}

export type DraftOutcome =
  | { fingerprint: string; ok: true; draftId: string }
  | { fingerprint: string; ok: false; error: string }

export type BatchDecision =
  /** Every draft landed — proceed to the single publish call. */
  | { action: 'publish'; draftIds: readonly string[] }
  /**
   * At least one draft failed. Delete the ones that DID land, then fail the
   * round. The MR must look untouched.
   */
  | {
      action: 'compensate'
      deleteDraftIds: readonly string[]
      failedFingerprints: readonly string[]
    }
  /** Nothing to post. Skipping the API call entirely is the correct no-op. */
  | { action: 'nothing-to-publish' }

/**
 * Decide what to do after the draft phase.
 *
 * The compensation list is the drafts that SUCCEEDED — those are the ones
 * visible on the MR. Compensating the failed ones instead (an easy inversion)
 * would delete nothing and leave the partial batch on display.
 */
export function decideBatch(outcomes: readonly DraftOutcome[]): BatchDecision {
  if (outcomes.length === 0) return { action: 'nothing-to-publish' }

  const created = outcomes.filter((o): o is Extract<DraftOutcome, { ok: true }> => o.ok)
  const failed = outcomes.filter((o): o is Extract<DraftOutcome, { ok: false }> => !o.ok)

  if (failed.length === 0) {
    return { action: 'publish', draftIds: created.map((o) => o.draftId) }
  }
  return {
    action: 'compensate',
    deleteDraftIds: created.map((o) => o.draftId),
    failedFingerprints: failed.map((o) => o.fingerprint),
  }
}

/**
 * Whether this provider has a partial-publish window at all.
 *
 * GitHub does not: one request carries everything, so a failure leaves nothing
 * behind and there is no compensation to run. Stated as a function rather than
 * assumed, because "add compensation everywhere to be safe" would have the
 * GitHub path issuing delete calls against draft ids that never existed.
 */
export function hasPartialPublishWindow(provider: 'gitlab' | 'github'): boolean {
  return provider === 'gitlab'
}
