// RFC-170 §6a — crash-recovery completeness theorem, encoded as a pure oracle.
//
// A crash can only land between two phase-COMMITs, so the strict boundary is
// `db-committed` (the atomic DB-authority write), and it belongs to the
// ROLL-FORWARD side:
//   - phase < db-committed  → rollback   (no external-visible authority depends
//                                          on the half-done work; undo is safe)
//   - phase ≥ db-committed  → rollforward (DB authority advanced; complete the
//                                          publish, NEVER undo a committed write)
//   - phase == done         → noop        (already terminal)
//
// The direction is NOT a function of `phase` alone: `fs-published` sits BEFORE
// db-committed in `reserve` (intent→fs-staged→fs-published→db-committed→done) but
// AFTER it in `version-write` (…→db-committed→fs-published→done). So the boundary
// is resolved per-kind against that kind's ordered phase spine (§6a per-kind
// tables). A phase absent from the kind's spine is an impossible state →
// quarantine (fail-closed, never guess).
//
// This is a pure oracle (no DB/FS) so it can be tested exhaustively over every
// (kind, phase) pair; the boot recovery driver (T-BOOT) dispatches the concrete
// rollback(op)/rollForward(op) programs off its verdict.

import type { SkillOpKind, SkillOpPhase } from './skillOperations'

export type RecoveryDirection = 'noop' | 'rollback' | 'rollforward' | 'quarantine'

/**
 * Ordered phase spine per kind (§6a). `db-committed` is the rollback↔rollforward
 * boundary. `replace` covers both the managed-occupier sub-machine
 * (intent→fs-staged→db-committed→done) and the pure-DB external-occupier one
 * (intent→done in a single tx, which never persists an intermediate); the union
 * of observable phases is the managed spine.
 */
export const SKILL_OP_PHASE_SEQUENCES: Record<SkillOpKind, readonly SkillOpPhase[]> = {
  reserve: ['intent', 'fs-staged', 'fs-published', 'db-committed', 'done'],
  migrate: ['intent', 'fs-staged', 'db-committed', 'done'],
  delete: ['intent', 'fs-staged', 'db-committed', 'done'],
  'version-write': ['intent', 'fs-staged', 'fs-versioned', 'db-committed', 'fs-published', 'done'],
  // RFC-178 removed `replace` (source-conflict) + `adopt-managed` (external
  // adoption). Neither was ever produced, so no persisted op row carries them.
}

/**
 * The §6a recovery verdict for an op observed at (kind, phase) on boot. Pure.
 * `quarantine` when the phase is not part of the kind's spine (impossible state).
 */
export function recoveryDirection(kind: SkillOpKind, phase: SkillOpPhase): RecoveryDirection {
  const spine = SKILL_OP_PHASE_SEQUENCES[kind]
  // Defensive: a persisted op with an unknown/removed kind (the DB CHECK still
  // admits the RFC-178-removed superset) has no spine → quarantine, never crash.
  if (spine === undefined) return 'quarantine'
  const idx = spine.indexOf(phase)
  if (idx === -1) return 'quarantine'
  if (phase === 'done') return 'noop'
  const boundary = spine.indexOf('db-committed')
  // Every spine contains db-committed; guard defensively anyway.
  if (boundary === -1) return 'quarantine'
  return idx < boundary ? 'rollback' : 'rollforward'
}
