// RFC-083 — eager persistence of the structural-diff artifact (no DB
// migration; mirrors how doc_versions keeps markdown on disk and the DB small).
//
// The baseline structural diff is recomputed live from the worktree on demand,
// but after worktree-GC the inputs are gone and a live recompute 410s. So when
// a TERMINAL task's diff is successfully computed, we persist it; if the
// worktree is later missing, the service serves the stored copy. Best-effort:
// a write failure never breaks the live response, and a malformed/absent
// artifact reads as null (→ falls back to the live path / 410).
//
// RFC-370 §10 V16 — the artifacts live behind the selected code-review
// artifact store (appHome files standalone, object publications hosted). These
// two helpers address the standalone files directly.

import { composeLocalCodeReviewArtifacts } from '@/modules/code-capability/public/participants'
import { TERMINAL_TASK_STATUSES as LIFECYCLE_TERMINAL_TASK_STATUSES } from '@/services/lifecycle'
import type { StructuralDiff, StructuralScope } from '@agent-workflow/shared'

/** Persist a structural-diff artifact in the standalone store. Best-effort — never throws. */
export async function writeStoredDiff(diff: StructuralDiff): Promise<void> {
  await composeLocalCodeReviewArtifacts().writeStructuralDiff(
    {
      taskId: diff.taskId,
      scope: diff.scope,
      ...(diff.nodeRunId === undefined ? {} : { nodeRunId: diff.nodeRunId }),
      generation: null,
    },
    diff,
  )
}

/** Read a standalone artifact, or null when absent / unreadable / malformed. */
export async function readStoredDiff(
  taskId: string,
  scope: StructuralScope,
  nodeRunId?: string,
): Promise<StructuralDiff | null> {
  return composeLocalCodeReviewArtifacts().readStructuralDiff({
    taskId,
    scope,
    ...(nodeRunId === undefined ? {} : { nodeRunId }),
    generation: null,
  })
}

// RFC-097: single source of truth in services/lifecycle.ts.
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set(LIFECYCLE_TERMINAL_TASK_STATUSES)

/** Whether a task status is terminal (worth persisting its structural diff,
 *  since a terminal task's worktree may be GC'd). */
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}
