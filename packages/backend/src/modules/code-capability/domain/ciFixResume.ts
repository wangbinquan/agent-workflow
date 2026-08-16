// RFC-304 §6.4 — what a `ci-fix` round inherits from the monitor turn that
// dispatched it.
//
// Domain rather than composition because the MONITOR is the caller, and the
// monitor is application-layer: keeping these next to the stage implementations
// would have pointed application at composition, the one direction RFC-294's
// layering does not allow. They are pure data anyway — no I/O, no ports.

import type {
  ClassifiedIssue,
  CollectResult,
} from '@/modules/code-capability/domain/monitorContracts'

/**
 * What the round inherits from the monitor turn that dispatched it.
 *
 * The four script stages at the head of the contract (`collect`, `classify`,
 * `arbitrate`, `select`) are the MONITOR's — `runMonitorWake` runs them to
 * decide there is a pipeline worth repairing, and only then opens a round. The
 * contract still declares them because they are genuinely the first four steps
 * of this chain and a hook mounts on each; the round starts at
 * `prepare-worktree` and records them `inherited`, which is what actually
 * happened.
 *
 * Re-running them inside the round instead would ask the code host the same
 * four questions a second time and — worse — could get different answers,
 * leaving the round repairing a failure other than the one it was dispatched
 * for.
 */
export function ciFixResumeArtifacts(input: {
  gateState: CollectResult
  issues: readonly ClassifiedIssue[]
  workPackage: unknown
  agentPlan?: unknown
}): Record<string, unknown> {
  return {
    gateState: input.gateState,
    issues: [...input.issues],
    workPackage: input.workPackage,
    ...(input.agentPlan === undefined ? {} : { agentPlan: input.agentPlan }),
  }
}

/** Where a `ci-fix` round begins; everything before it belongs to the monitor. */
export const CI_FIX_RESUME_STAGE = 'prepare-worktree'
