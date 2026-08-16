// RFC-304 §11.6 (T65) — changing 200 repositories without a three-level
// inheritance model.
//
// The obvious design is inheritance: set a value at the organisation level and
// let repositories inherit it. The RFC rejected that (it overturns F11/G4, and
// the reversal is parked in §6bis-B for the user to decide), and the reason is
// worth restating because it will be proposed again:
//
//   with inheritance, "why is this repository doing that?" has no local answer.
//   The cell shows nothing; the value lives somewhere the reader has to go
//   find, and the answer changes when somebody edits a level they cannot see.
//   Every support question becomes an archaeology exercise.
//
// So a bulk change is an EXPLICIT WRITE TO EACH CELL. The matrix stays the
// single source of truth, each cell keeps saying what it does, and "bulk" is a
// property of the editing tool rather than of the data model.
//
// The cost is that a bulk edit is a real edit — which is why preview and revert
// are part of the same feature rather than a later refinement.

export interface CellSelector {
  /** Repository ids to touch. Empty means the selector matched nothing. */
  repoIds: readonly string[]
  capability: string
}

export interface CellChange {
  repoId: string
  capability: string
  /** What the cell holds now; null when the cell does not exist yet. */
  before: { enabled: boolean; bindingId: string | null } | null
  after: { enabled: boolean; bindingId: string | null }
}

export type ChangeKind = 'create' | 'update' | 'no-op'

export function classifyChange(change: CellChange): ChangeKind {
  if (change.before === null) return 'create'
  if (
    change.before.enabled === change.after.enabled &&
    change.before.bindingId === change.after.bindingId
  ) {
    return 'no-op'
  }
  return 'update'
}

export interface BulkPreview {
  creates: readonly CellChange[]
  updates: readonly CellChange[]
  /** Cells the selector matched that already hold the target value. */
  noOps: readonly CellChange[]
  message: string
}

/**
 * What a bulk apply would do, before it does it.
 *
 * No-ops are counted separately and shown, rather than filtered out silently.
 * "This will change 12 repositories" reads very differently from "this matched
 * 200 repositories, 188 of which are already set" — and the second is what
 * tells the author their selector is wider than they meant, which is the
 * mistake a bulk tool makes easy.
 */
export function previewBulk(changes: readonly CellChange[]): BulkPreview {
  const creates = changes.filter((c) => classifyChange(c) === 'create')
  const updates = changes.filter((c) => classifyChange(c) === 'update')
  const noOps = changes.filter((c) => classifyChange(c) === 'no-op')

  const parts: string[] = []
  if (creates.length > 0) parts.push(`${String(creates.length)} to create`)
  if (updates.length > 0) parts.push(`${String(updates.length)} to change`)
  if (noOps.length > 0) parts.push(`${String(noOps.length)} already set`)

  return {
    creates,
    updates,
    noOps,
    message: parts.length === 0 ? 'This selector matches nothing.' : `${parts.join(', ')}.`,
  }
}

/**
 * The inverse of an applied batch, for one-click revert.
 *
 * Built from the recorded `before` rather than re-derived from the current
 * state: by the time somebody reverts, other edits may have landed, and
 * re-deriving would either clobber them or fail. Reverting restores exactly
 * what this batch changed and nothing else.
 *
 * A cell that did not exist before is reverted by DISABLING it rather than by
 * deletion, because deletion would also discard whatever readiness and trigger
 * configuration the create brought along — a revert that destroys more than the
 * thing it reverses is not one.
 */
export function invertBatch(applied: readonly CellChange[]): CellChange[] {
  return applied
    .filter((c) => classifyChange(c) !== 'no-op')
    .map((c) => ({
      repoId: c.repoId,
      capability: c.capability,
      before: c.after,
      after: c.before ?? { enabled: false, bindingId: null },
    }))
}

/**
 * RFC-304 §11.6 — the single read model for "what does this cell actually do".
 *
 * One function, because the question is asked from the matrix page, the round
 * runner and the readiness check, and three implementations of it will disagree
 * the first time one of them is updated. The disagreement is invisible: each
 * caller is self-consistent, and the platform simply behaves differently from
 * what the page shows.
 */
export interface EffectiveCapabilityConfig {
  repoId: string
  capability: string
  enabled: boolean
  bindingId: string | null
  /** Where each value came from — the answer to "why is it this?". */
  source: 'cell'
}

export function effectiveConfig(cell: {
  repoId: string
  capability: string
  enabled: boolean
  bindingId: string | null
}): EffectiveCapabilityConfig {
  // `source` is a constant today and is stated anyway: it is the field that
  // would have to grow values if inheritance were ever added, and its presence
  // means the read model would not have to change shape to say so.
  return { ...cell, source: 'cell' }
}
