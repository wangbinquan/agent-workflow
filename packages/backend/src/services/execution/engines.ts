// RFC-243 T3 — the explicit engine registry. `scheduler.runTask` used to
// inline the workgroup/dw dispatch decision at its fork point; this module is
// that decision, extracted verbatim as a pure function so the "which engine
// drives this task" oracle lives in the executor namespace (design §1.2). The
// engine BODIES stay where they are (runScope / runWorkgroupEngine /
// runDynamicWorkflowGenerate in scheduler.ts) — proposal D3 forbids merging
// the DAG frontier and the round engine.
import {
  deriveWorkgroupDispatch,
  isWorkgroupTask,
  workgroupModeOf,
  type DynamicWorkflowPhase,
  type WorkgroupDispatch,
} from '@agent-workflow/shared'

/** Which loop drives the task. `dag` covers plain workflows AND dw-execute. */
export type TaskEngineKind = 'dag' | 'workgroup-turns' | 'dw-generate'

export type ResolvedTaskEngine = {
  engine: TaskEngineKind
  /**
   * The raw workgroup dispatch (null for non-workgroup tasks). Kept alongside
   * `engine` because the scheduler's dw-phase-invariant fail-fast needs to
   * distinguish "dag because plain workflow" from "dag because dw-execute".
   */
  wgDispatch: WorkgroupDispatch | null
}

/**
 * Pure resolver: (task row fields, dw phase) → engine. Exactly the decision
 * previously inlined at scheduler.ts (RFC-164/167/217 semantics, byte-equal):
 * non-workgroup → dag; workgroup → deriveWorkgroupDispatch(mode, dwPhase)
 * with 'dw-execute' running the ordinary DAG over the swapped-in snapshot.
 */
export function resolveTaskEngine(
  task: { workgroupId?: string | null; workgroupConfigJson?: string | null },
  dwPhase: DynamicWorkflowPhase | null,
): ResolvedTaskEngine {
  if (!isWorkgroupTask(task)) return { engine: 'dag', wgDispatch: null }
  const wgDispatch = deriveWorkgroupDispatch(
    workgroupModeOf(task.workgroupConfigJson) ?? 'leader_worker',
    dwPhase,
  )
  const engine: TaskEngineKind =
    wgDispatch === 'dw-generate'
      ? 'dw-generate'
      : wgDispatch === 'turn-engine'
        ? 'workgroup-turns'
        : 'dag'
  return { engine, wgDispatch }
}
