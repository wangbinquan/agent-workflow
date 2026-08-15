// RFC-304 §7 — publishing is a two-phase operation with a durable intent.
//
// The bug this exists to prevent is user-visible and embarrassing: `publish`
// succeeds, then the daemon is preempted or crashes before `ledger` records the
// external ids. The remarks now EXIST on the MR while the ledger has no id for
// them, so the next round's reconciliation classifies the same findings as
// "new" and posts them again. The author sees every comment twice.
//
// So publishing is never one action:
//
//   1. before calling out, persist an intent: batchId + the fingerprints about
//      to be posted + the target anchor + the epoch;
//   2. after the remote call succeeds, atomically write back the external ids
//      (tagged with the batchId) BEFORE allowing cancellation or the next stage;
//   3. on restart, any batch in "intent written, result not written" is
//      RECONCILED AGAINST THE REMOTE — GitLab by the MR's drafts/notes, GitHub
//      by its reviews — and only re-sent if genuinely absent.
//
// Step 3 is the one that cannot be skipped. Without it, recovery has to guess,
// and both guesses are wrong: assume sent ⇒ silently lose a round's findings;
// assume not sent ⇒ post everything twice.

export type PublishIntentState =
  /** Intent persisted; the remote call has not been made (or its result is unknown). */
  | 'pending'
  /** Remote call succeeded AND external ids are written back. */
  | 'settled'
  /** Remote call failed and the compensation (draft cleanup) completed. */
  | 'compensated'
  /** Superseded before the call went out; nothing was posted. */
  | 'abandoned'

export interface PublishIntent {
  batchId: string
  roundId: string
  /** The work item's epoch when the intent was written; a stale batch is ignorable. */
  epoch: number
  state: PublishIntentState
  /** What this batch intends to post, by finding fingerprint. */
  fingerprints: readonly string[]
  /** Filled on settle: fingerprint → the code host's id for that comment. */
  externalIds: Readonly<Record<string, string>>
}

/** What the remote actually has for this batch, as observed during recovery. */
export interface RemoteBatchObservation {
  /** fingerprint → external id, for entries the code host reports as present. */
  present: Readonly<Record<string, string>>
}

export type PublishRecoveryPlan =
  /** Nothing was posted — send the whole batch. */
  | { action: 'resend'; fingerprints: readonly string[] }
  /** Everything is already there — just record the ids. */
  | { action: 'adopt'; externalIds: Readonly<Record<string, string>> }
  /**
   * A partial batch. Record what exists and send only the rest — resending the
   * whole batch would duplicate the part that landed.
   */
  | { action: 'complete'; adopt: Readonly<Record<string, string>>; resend: readonly string[] }
  /** The batch is already settled or was abandoned; nothing to do. */
  | { action: 'none'; reason: string }

/**
 * Decide what recovery should do with one intent, given what the remote reports.
 *
 * Pure: recovery's correctness is entirely in this decision, and it must be
 * testable without a code host. The caller performs the sends and the writes.
 */
export function planPublishRecovery(
  intent: PublishIntent,
  observed: RemoteBatchObservation,
): PublishRecoveryPlan {
  if (intent.state === 'settled') {
    return { action: 'none', reason: 'batch already settled' }
  }
  if (intent.state === 'abandoned' || intent.state === 'compensated') {
    return { action: 'none', reason: `batch is ${intent.state}` }
  }

  const adopt: Record<string, string> = {}
  const resend: string[] = []
  for (const fingerprint of intent.fingerprints) {
    const id = observed.present[fingerprint]
    if (id === undefined) resend.push(fingerprint)
    else adopt[fingerprint] = id
  }

  if (resend.length === 0) return { action: 'adopt', externalIds: adopt }
  if (Object.keys(adopt).length === 0) return { action: 'resend', fingerprints: resend }
  // The partial case is the one a naive implementation gets wrong: it is
  // tempting to resend the batch and let the code host dedupe. It will not.
  return { action: 'complete', adopt, resend }
}

/**
 * Whether a settled intent's write-back is complete.
 *
 * A batch that reports `settled` while missing ids for some of its fingerprints
 * is worse than one that reports `pending`: recovery skips it, and the next
 * reconciliation re-posts exactly the entries whose ids are missing.
 */
export function isWriteBackComplete(intent: PublishIntent): boolean {
  return intent.fingerprints.every((f) => intent.externalIds[f] !== undefined)
}
