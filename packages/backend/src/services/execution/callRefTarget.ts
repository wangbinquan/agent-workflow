// RFC-291 面 D (T6a) — the ONE place that decides which row a call selector
// binds to.
//
// Why this is a single function rather than "the same rule written twice":
// three call sites must agree byte-for-byte, and they read from different
// stores. `freezeCallClosure` resolves against the DB at launch and freezes the
// answer into the task; the intent dump resolves against an in-memory
// actor-visible catalog so the model can be shown WHICH mounted handle an edge
// points at. If those two ever pick different rows, the user edits W1 in an
// intent session while the platform keeps executing W2 — a divergence nothing
// downstream can detect, because each side is internally consistent.
//
// The rule itself carries a security lesson (RFC-243 impl-gate P0-1): the id
// cache is only honoured when that row STILL bears the selector's name and is
// visible to this actor. Without the name check a renamed row keeps being
// bound; without the visibility check a same-name row invisible to the launcher
// could be frozen into the snapshot and executed.
//
// `workflows.name` is NOT unique (YAML import collisions are a legal state), so
// the name fallback must be deterministic rather than "first row the query
// happened to return": oldest visible ULID wins.

/** Minimal shape a candidate row must expose to be resolvable. */
export interface CallTargetRow {
  id: string
  name: string
}

export interface CallTargetSelector {
  /** The authoritative selector — the name the author picked. */
  authoritativeName: string
  /** Local id cache (`workflowId` / `workgroupId`); advisory, never trusted alone. */
  idHint?: string
}

/**
 * Pick the row a call selector binds to, or `undefined` when nothing matches.
 *
 * `candidates` MUST already be filtered to rows this actor can see — visibility
 * is the caller's job (it owns the ACL context), selection is this function's.
 * Order is irrelevant: the tie-break sorts internally so a caller cannot change
 * the outcome by handing rows over in a different order.
 */
export function pickCallTarget<T extends CallTargetRow>(
  selector: CallTargetSelector,
  candidates: readonly T[],
): T | undefined {
  const { authoritativeName, idHint } = selector

  // ① id cache — honoured ONLY while that row still carries the selector name.
  //    (Presence in `candidates` is what proves it is visible to this actor.)
  if (idHint !== undefined) {
    const hinted = candidates.find((row) => row.id === idHint)
    if (hinted !== undefined && hinted.name === authoritativeName) return hinted
  }

  // ② name fallback — deterministic among same-name rows: oldest ULID wins.
  //    ULIDs sort lexicographically by mint time, so `<` is an age comparison.
  let oldest: T | undefined
  for (const row of candidates) {
    if (row.name !== authoritativeName) continue
    if (oldest === undefined || row.id < oldest.id) oldest = row
  }
  return oldest
}
