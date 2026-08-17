// RFC-304 §3.1 (T16c) — readiness is derived, so it has to be invalidated.
//
// `readiness` is cached on each repo × capability cell so the matrix can render
// without recomputing everything. Everything it depends on — the binding, the
// framework, the bound agents, the webhook trigger, the code-host connection,
// the CI wake entry — can change or be deleted after the cell went `ready`.
//
// Without invalidation both directions fail, and both are silent:
//
//   deleting one shared binding leaves EVERY cell that used it still showing
//   `ready`, and the failure only surfaces when an event arrives;
//   a user who fixes a missing prerequisite stays stuck on `misconfigured`,
//   with no way to tell the platform to look again.
//
// The rule (design §3.1): prefer computing live; if cached, store a
// `dependencyRevision` alongside and invalidate on dependency change. This
// module owns the mapping from "what changed" to "which cells are now stale",
// as a pure function — the sweep that acts on it is infrastructure.

/** A thing a cell's readiness depends on. */
export type ReadinessDependency =
  | { kind: 'binding'; templateId: string }
  | { kind: 'framework'; frameworkId: string }
  | { kind: 'agent'; agentId: string }
  | { kind: 'trigger'; repoId: string }
  | { kind: 'code-host'; endpointId: string }
  | { kind: 'wake-source'; repoId: string }

/** What a cell currently depends on, as recorded when its readiness was computed. */
export interface CellDependencySnapshot {
  cellId: string
  repoId: string
  templateId: string | null
  frameworkId: string | null
  /** Agent ids referenced by the binding's slots. */
  agentIds: readonly string[]
  codeHostEndpointId: string | null
}

/**
 * Which cells a change invalidates.
 *
 * Returns cell ids rather than mutating, so the caller can batch the write —
 * one shared binding can easily be referenced by hundreds of cells, and issuing
 * hundreds of individual updates from inside a change handler is how a config
 * edit turns into a visible stall.
 */
export function cellsInvalidatedBy(
  change: ReadinessDependency,
  cells: readonly CellDependencySnapshot[],
): string[] {
  const hit = (cell: CellDependencySnapshot): boolean => {
    switch (change.kind) {
      case 'binding':
        return cell.templateId === change.templateId
      case 'framework':
        // Cells reach a framework THROUGH their binding, so a framework change
        // has to match on the resolved id rather than on the binding — a cell
        // whose binding points at the changed framework is affected even though
        // its own binding did not change.
        return cell.frameworkId === change.frameworkId
      case 'agent':
        return cell.agentIds.includes(change.agentId)
      case 'trigger':
      case 'wake-source':
        return cell.repoId === change.repoId
      case 'code-host':
        return cell.codeHostEndpointId === change.endpointId
    }
  }
  return cells.filter(hit).map((c) => c.cellId)
}

/**
 * Whether a cached readiness may be trusted.
 *
 * Two independent reasons to distrust it, and they catch different failures:
 * a revision bump means a dependency changed since the value was computed; an
 * age limit catches everything the revision mechanism MISSED — a dependency
 * nobody wired a change event for, or an event dropped by a restart. Without
 * the second, a single unwired dependency produces a cell that is permanently,
 * confidently wrong.
 */
export function isReadinessFresh(input: {
  cachedRevision: number
  currentRevision: number
  lastValidatedAt: number | null
  now: number
  maxAgeMs: number
}): boolean {
  if (input.cachedRevision !== input.currentRevision) return false
  if (input.lastValidatedAt === null) return false
  return input.now - input.lastValidatedAt < input.maxAgeMs
}

/**
 * Capabilities whose readiness must include a wake source (AC-14d).
 *
 * `ci-fix` is woken by a pipeline event or an explicit wake entry; with neither,
 * every other prerequisite can be satisfied and the cell would show `ready`
 * while nothing on earth could start it. Stated as data so the readiness
 * derivation and this list cannot drift apart.
 */
export const WAKE_SOURCE_REQUIRED_CAPABILITIES: readonly string[] = ['ci-fix', 'mr-monitor']

export function requiresWakeSource(capability: string): boolean {
  return WAKE_SOURCE_REQUIRED_CAPABILITIES.includes(capability)
}
