// RFC-354 — "which rows belong to this wrapper execution" as ONE primitive
// (PURE). Replaces the three approximations that each answered it their own
// way: `wrapperRevivalEvidence` (inner node ids ∩ a single iteration — the
// depth-1 blind spot, audit S-3), `runLiveness.innerRunsOf` (parent pointer OR
// inner node ids) and the retry / rollback cascades.
//
// Membership is transitive through the container chain: a row whose
// `containerRunId` chain passes through the generation row is a member, at any
// depth. The generation row itself is not its own member.
//
// Locks: tests/rfc354-container-membership.test.ts.

export interface ContainedRunRow {
  readonly id: string
  /** Optional only for plain test-fixture rows; a real DB row always carries the column. */
  readonly containerRunId?: string | null
}

/** Container ids from the nearest enclosing generation row up to the root. */
export function frameChainOf<R extends ContainedRunRow>(
  row: R,
  rowById: (id: string) => R | undefined,
): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  // `?? null` normalizes plain test-fixture rows; a real DB row always carries the column.
  let current: string | null = row.containerRunId ?? null
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    chain.push(current)
    current = rowById(current)?.containerRunId ?? null
  }
  return chain
}

/**
 * Every row (in input order) that hangs — directly or through nested
 * generation rows — off the generation row `containerRunId`.
 */
export function containerMemberRuns<R extends ContainedRunRow>(
  containerRunId: string,
  rows: readonly R[],
): R[] {
  const byId = new Map<string, R>()
  for (const row of rows) byId.set(row.id, row)
  const lookup = (id: string): R | undefined => byId.get(id)
  return rows.filter(
    (row) => row.id !== containerRunId && frameChainOf(row, lookup).includes(containerRunId),
  )
}
