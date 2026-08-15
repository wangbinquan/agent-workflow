// RFC-304 §6 — the findings ledger as a stage sees it.
//
// A port rather than the `DbClient` itself, for the same reason
// `attemptRecorder` is one: a stage that took a database handle could reach any
// table in the schema, and the layering rule that keeps stage logic testable
// without a database would hold only by convention.
//
// Bound at composition time to the round and capability it belongs to, so a
// stage cannot accidentally write into another round's history. The ANCHOR is
// per call, because it comes from `resolve-target` — a stage artifact, not a
// composition-time fact.

import type { LedgerFinding } from '@/modules/code-capability/domain/findingReconcile'
import type { LedgerAnchor } from '@/modules/code-capability/infrastructure/sqliteFindingLedger'

export interface RecordPublishedArgs {
  anchor: LedgerAnchor
  fingerprint: string
  generation: number
  externalId: string | null
  severity?: string | undefined
  title?: string | undefined
  filePath?: string | undefined
  anchorLine?: number | undefined
}

export interface FindingLedgerPort {
  /** Every row for this anchor, including `disappeared` ones (reconcile needs them). */
  read(anchor: LedgerAnchor): Promise<LedgerFinding[]>
  recordPublished(args: RecordPublishedArgs): Promise<void>
  /** Still present: refresh `lastSeenAt` and follow the line if it drifted. */
  refreshSeen(anchor: LedgerAnchor, fingerprint: string, anchorLine: number | null): Promise<void>
  /**
   * The active→disappeared edge. Returns whether THIS call made the transition,
   * which is what keeps the provider action to exactly once: a second round
   * finds nothing active to move and gets `false`.
   */
  markDisappeared(anchor: LedgerAnchor, fingerprint: string): Promise<boolean>

  /**
   * Record an adoption signal (T30). First observation wins.
   *
   * Once, not every round: the value being kept is WHEN somebody acted, and
   * overwriting it each round would turn a date into "the last time we looked".
   */
  markAdoption(
    anchor: LedgerAnchor,
    fingerprint: string,
    signal: 'resolved' | 'code-changed',
  ): Promise<boolean>

  /** What the ledger recorded as each finding's anchor, for drift detection. */
  readAnchors(
    anchor: LedgerAnchor,
  ): Promise<Array<{ fingerprint: string; anchorLine: number | null }>>
}
