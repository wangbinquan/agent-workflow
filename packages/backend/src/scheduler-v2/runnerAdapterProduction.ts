// RFC-061 PR-B T9-extra — production RunnerAdapter scaffold.
//
// This is the bridge between scheduler-v2's pure SpawnRequest API and
// the existing services/runner.ts (which spawns opencode subprocesses).
// The full implementation requires the legacy-services hard cut (T10)
// because today's runner.runNode signature requires a `nodeRunId` of a
// pre-existing `node_runs` row — a table that DROPs in migration 0034.
//
// For now this file documents the EXACT cut points the T10/T11 commit
// must fill in. Production code paths still use the legacy scheduler;
// taskActor + MockRunnerAdapter cover the new world in tests.
//
// **T10/T11 cutover checklist** (each TODO below maps to one cut):
//
//   1. spawn():
//      - Resolve agent + skill bundle from frontmatter (already done
//        in services/runner.buildInlineConfig — extract that helper)
//      - Compute promptCtx (clarify / cross-clarify / review prompt
//        contexts) — today these come from services/clarify.ts /
//        crossClarify.ts / review.ts; in the new world they live in
//        SIGNAL_KIND_HANDLERS[*].renderPromptSection and are already
//        baked into SpawnRequest.prompt by computeTickActions.
//      - Spawn opencode subprocess (existing services/runner.ts has
//        the OPENCODE_CONFIG_CONTENT / OPENCODE_CONFIG_DIR plumbing)
//      - On exit: emit attempt-exit wake via the bound WakeProducer.
//
//   2. cancel():
//      - Look up the opencode pid from `attempts` projection (no longer
//        from `node_runs`) by attemptId
//      - SIGTERM (existing pattern in scheduler-v2 cancellation hook)
//      - The runner emits attempt-canceled event when the process actually
//        dies.

import type { DbClient } from '../db/client'
import type { RunnerAdapter, WakeProducer } from './runnerAdapter'
import type { SpawnRequest } from './taskActorTick'

export interface ProductionRunnerAdapterOptions {
  db: DbClient
  /** Per-task worktree path; resolved at task launch. */
  worktreePath: string
  /** App home (~/.agent-workflow) for OPENCODE_CONFIG_DIR per-attempt dirs. */
  appHome: string
  /** Bound at construction; the actor's wake queue. */
  wakeProducer: WakeProducer
}

const NOT_YET_WIRED =
  'ProductionRunnerAdapter requires T10/T11 cutover (delete legacy services + migration 0034). See file header for the integration checklist.'

/**
 * Scaffold for the production runner. The interface implementation exists
 * so callers in scheduler-v2/ can already type against it; runtime
 * methods throw clearly until the T10/T11 commit fills them in.
 *
 * **Do NOT register an instance with taskActorRegistry's runtime path
 * yet** — it will throw on every spawn. Tests use MockRunnerAdapter.
 */
export class ProductionRunnerAdapter implements RunnerAdapter {
  constructor(public readonly opts: ProductionRunnerAdapterOptions) {}

  async spawn(req: SpawnRequest): Promise<void> {
    void req
    throw new Error(`spawn: ${NOT_YET_WIRED}`)
  }

  async cancel(attemptId: string, reason: string): Promise<void> {
    void attemptId
    void reason
    throw new Error(`cancel: ${NOT_YET_WIRED}`)
  }
}

/**
 * Convenience factory documenting the daemon's expected setup flow.
 * The T10/T11 commit will call this from services/task.ts launch path.
 */
export function createProductionRunnerAdapter(
  opts: ProductionRunnerAdapterOptions,
): ProductionRunnerAdapter {
  return new ProductionRunnerAdapter(opts)
}
