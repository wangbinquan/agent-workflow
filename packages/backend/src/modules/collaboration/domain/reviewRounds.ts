// RFC-493 (RFC-294 S13): review round rules, moved verbatim from `infrastructure/review.ts` — the round mode a decision
// selects and grouping doc versions into rounds.

import { type DocVersionDecision, type TaskActorRole } from '@agent-workflow/shared'

// ---------------------------------------------------------------------------
// RFC-149: review round mode — decision-side single source of truth.
// ---------------------------------------------------------------------------

/**
 * Resolve a review round's mode from its doc_versions rows (RFC-149 §2).
 * DECISION-side oracle only: dispatch (dispatchReviewNode) derives the mode
 * from the upstream port KIND — it is the producer of these rows and stays
 * kind-driven — while every reader that used to re-derive the mode from the
 * archived data shape (item_index / item_path NULL sentinels) goes through
 * here instead of hand-rolling the sentinels.
 *
 *   - 'single'       — no member carries item_index (single-document round)
 *   - 'multi-inline' — multi-document, items are INLINE markdown bodies
 *                      (list<markdown>: item_path NULL on every member)
 *   - 'multi-path'   — multi-document, items are worktree paths
 *                      (list<path<md>>: item_path set)
 *
 * Empty array ⇒ 'single' (`some` over [] is false — callers reject empty
 * rounds before the mode matters; the grid is locked in
 * rfc149-decision-policy.test.ts).
 */
export function resolveReviewRoundMode(
  dvs: ReadonlyArray<{ itemIndex?: number | null; itemPath?: string | null }>,
): 'single' | 'multi-inline' | 'multi-path' {
  const isMultiDoc = dvs.some((d) => d.itemIndex !== null && d.itemIndex !== undefined)
  if (!isMultiDoc) return 'single'
  const itemsInline = dvs.length > 0 && dvs.every((d) => (d.itemPath ?? null) === null)
  return itemsInline ? 'multi-inline' : 'multi-path'
}

/**
 * Minimal doc_versions row slice `groupDocVersionRounds` needs. Structurally
 * satisfied by drizzle's full row; tests can hand-build these (pure, no IO).
 */
export interface RoundGroupRow {
  id: string
  reviewIteration: number
  roundGeneration: number | null
  itemIndex: number | null
  decision: string
  decisionReason: string | null
  decidedAt: number | null
  decidedBy: string | null
  decidedByRole: string | null
  createdAt: number
}

export interface DocVersionRound<R extends RoundGroupRow> {
  roundKey: string
  reviewIteration: number
  roundGeneration: number | null
  decision: DocVersionDecision
  decisionReason: string | null
  decidedAt: number | null
  decidedBy: string | null
  decidedByRole: TaskActorRole | null
  createdAt: number
  isCurrent: boolean
  /** item_index ascending. */
  members: R[]
  /** Diagnostics only: members disagree on decision (writer stamps a whole round at once). */
  hasMixedDecisions: boolean
}

/**
 * RFC-142: group a review's doc_versions rows into rounds (pure, exported for
 * unit tests).
 *
 * Grouping key: rows with a round_generation group by it (`g{n}`); legacy
 * NULL-generation rows (pre-migration-0070) group by review_iteration
 * (`i{n}-legacy`). Order: legacy rounds first by iteration — every post-0070
 * mint stamps a generation, so legacy rows are necessarily older — then
 * generation rounds in generation order (strictly monotonic per mint,
 * loadPriorRound's counter).
 *
 * Round-level fields (design D4): decision = first non-pending member (the
 * decision writer stamps a whole round at once — heterogeneity is surfaced
 * via hasMixedDecisions for the caller to warn on); decisionReason only for
 * rejected (shared reject reason) and superseded ('upstream-refreshed'
 * system marker) — iterated feedback lives in each member's frozen comments;
 * decided* from the member with the newest decidedAt; createdAt =
 * min(member.createdAt); isCurrent = the pending round, else the newest —
 * matching what getReviewDetail renders (G4-fixed selection).
 */
export function groupDocVersionRounds<R extends RoundGroupRow>(
  rows: readonly R[],
): DocVersionRound<R>[] {
  const items = rows.filter((r) => r.itemIndex !== null)
  if (items.length === 0) return []
  const byKey = new Map<string, R[]>()
  for (const r of items) {
    const key =
      r.roundGeneration !== null ? `g${r.roundGeneration}` : `i${r.reviewIteration}-legacy`
    const list = byKey.get(key)
    if (list === undefined) byKey.set(key, [r])
    else list.push(r)
  }
  const groups: DocVersionRound<R>[] = [...byKey.entries()].map(([roundKey, members]) => {
    members.sort((a, b) =>
      (a.itemIndex ?? 0) !== (b.itemIndex ?? 0)
        ? (a.itemIndex ?? 0) - (b.itemIndex ?? 0)
        : a.id < b.id
          ? -1
          : 1,
    )
    const decision = (members.find((m) => m.decision !== 'pending')?.decision ??
      'pending') as DocVersionDecision
    const decisionReason =
      decision === 'rejected' || decision === 'superseded'
        ? (members.find((m) => m.decisionReason !== null && m.decisionReason !== '')
            ?.decisionReason ?? null)
        : null
    let decider: R | undefined
    for (const m of members) {
      if (m.decidedAt === null) continue
      if (decider === undefined || (decider.decidedAt ?? 0) < m.decidedAt) decider = m
    }
    const first = members[0]!
    return {
      roundKey,
      reviewIteration: first.reviewIteration,
      roundGeneration: first.roundGeneration,
      decision,
      decisionReason,
      decidedAt: decider?.decidedAt ?? null,
      decidedBy: decider?.decidedBy ?? null,
      decidedByRole: (decider?.decidedByRole ?? null) as DocVersionRound<R>['decidedByRole'],
      createdAt: Math.min(...members.map((m) => m.createdAt)),
      isCurrent: false,
      members,
      hasMixedDecisions: new Set(members.map((m) => m.decision)).size > 1,
    }
  })
  groups.sort((a, b) => {
    const aLegacy = a.roundGeneration === null
    const bLegacy = b.roundGeneration === null
    if (aLegacy !== bLegacy) return aLegacy ? -1 : 1
    if (aLegacy) return a.reviewIteration - b.reviewIteration
    return (a.roundGeneration as number) - (b.roundGeneration as number)
  })
  const pendingIdx = groups.findIndex((g) => g.decision === 'pending')
  ;(pendingIdx >= 0 ? groups[pendingIdx]! : groups[groups.length - 1]!).isCurrent = true
  return groups
}
