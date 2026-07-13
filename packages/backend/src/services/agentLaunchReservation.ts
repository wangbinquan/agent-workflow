// RFC-175 (§2e) — in-process agent-launch identity reservation.
//
// A single-agent launch resolves an agent id, then materializes a worktree and
// INSERTs the task in separate steps. Without a guard, the agent can be
// deleted+recreated (new id, same name) or renamed in that window — the runtime
// resolves the agent by NAME from the frozen snapshot, so it would run the
// REPLACEMENT while the task recorded the original id (an ABA).
//
// The daemon is a single flock-guarded process (see cli/start.ts), so an
// in-process reservation is sufficient — no durable store, no crash cleanup (a
// crash restarts the process, clearing the map, and the half-materialized
// worktree falls to the existing interrupted/GC handling, not a new surface).
//
// REFERENCE-COUNTED (not a naive set): the id is SHARED by concurrent launches
// of the same agent (unlike `materializingSpaces`, keyed by a unique task id).
// If one launch released the key while another was still materializing, the
// window would reopen — so the key is removed only when the LAST holder
// releases. `deleteAgent`/`renameAgent` refuse (`agent-launching` 409) while
// any launch holds the agent's id.

/** agent id → number of in-flight launches currently holding it. */
const launchingAgentIds = new Map<string, number>()

/** Register one in-flight launch of `agentId`. Pair with `releaseAgentLaunch` in a `finally`. */
export function acquireAgentLaunch(agentId: string): void {
  launchingAgentIds.set(agentId, (launchingAgentIds.get(agentId) ?? 0) + 1)
}

/** Release one in-flight launch of `agentId`; the id is dropped when the count hits 0. */
export function releaseAgentLaunch(agentId: string): void {
  const n = launchingAgentIds.get(agentId)
  if (n === undefined) return
  if (n <= 1) launchingAgentIds.delete(agentId)
  else launchingAgentIds.set(agentId, n - 1)
}

/** True while at least one launch holds `agentId` (delete/rename must refuse). */
export function isAgentLaunching(agentId: string): boolean {
  return (launchingAgentIds.get(agentId) ?? 0) > 0
}
