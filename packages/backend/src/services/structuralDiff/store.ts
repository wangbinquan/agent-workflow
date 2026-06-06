// RFC-083 — eager persistence of the structural-diff artifact on disk (no DB
// migration; mirrors how doc_versions keeps markdown on disk and the DB small).
//
// The baseline structural diff is recomputed live from the worktree on demand,
// but after worktree-GC the inputs are gone and a live recompute 410s. So when
// a TERMINAL task's task-scope diff is successfully computed, we persist it
// under appHome()/structural-diffs/{taskId}/{scope}.json; if the worktree is
// later missing, the service serves the stored copy. Best-effort: a write
// failure never breaks the live response, and a malformed/absent file reads as
// null (→ falls back to the live path / 410).

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { appHome } from '@/util/paths'
import {
  structuralDiffSchema,
  type StructuralDiff,
  type StructuralScope,
} from '@agent-workflow/shared'

function storedDiffPath(taskId: string, scope: StructuralScope, nodeRunId?: string): string {
  const name = nodeRunId !== undefined && nodeRunId !== '' ? `${scope}-${nodeRunId}` : scope
  // taskId is a ULID (no path separators); scope/nodeRunId are bounded — safe.
  return join(appHome(), 'structural-diffs', taskId, `${name}.json`)
}

/** Persist a structural-diff artifact. Best-effort — never throws. */
export async function writeStoredDiff(diff: StructuralDiff): Promise<void> {
  try {
    const path = storedDiffPath(diff.taskId, diff.scope, diff.nodeRunId)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify(diff), 'utf8')
  } catch {
    // storage is an optimization; a failure must not affect the live response.
  }
}

/** Read a persisted artifact, or null when absent / unreadable / malformed. */
export async function readStoredDiff(
  taskId: string,
  scope: StructuralScope,
  nodeRunId?: string,
): Promise<StructuralDiff | null> {
  try {
    const raw = await readFile(storedDiffPath(taskId, scope, nodeRunId), 'utf8')
    const parsed = structuralDiffSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  'done',
  'failed',
  'canceled',
  'interrupted',
])

/** Whether a task status is terminal (worth persisting its structural diff,
 *  since a terminal task's worktree may be GC'd). */
export function isTerminalTaskStatus(status: string): boolean {
  return TERMINAL_TASK_STATUSES.has(status)
}
