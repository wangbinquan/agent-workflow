// RFC-083 — structural diff service. Mirrors getTaskDiff's task →
// (worktree, baseCommit) resolution + error codes (no-base-commit 409,
// worktree-missing 410) so the structural view degrades exactly like the
// textual diff. Single-repo computes directly; multi-repo merges per-repo
// results (status 'partial' when some repos are unusable).
//
// Scopes: 'task' (base_commit → worktree), 'node' (a write node's pre_snapshot
// → the next write node's pre_snapshot / worktree, single-repo). 'wrapper' is
// not yet wired and returns a typed 'structural-scope-unsupported'.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { computeSummary, type StructuralDiff, type StructuralScope } from '@agent-workflow/shared'
import { getTask } from '@/services/task'
import { computeFromWorktree, computeBetweenRefs } from './gitBackend'
import { mergeStructuralDiffs } from './assemble'
import { resolveNodeScope } from './refSelect'
import { readStoredDiff, writeStoredDiff, isTerminalTaskStatus } from './store'

export async function getTaskStructuralDiff(
  db: DbClient,
  taskId: string,
  scope: StructuralScope = 'task',
  nodeRunId?: string,
): Promise<StructuralDiff> {
  if (scope === 'wrapper') {
    throw new ValidationError(
      'structural-scope-unsupported',
      `structural-diff scope 'wrapper' is not yet supported`,
    )
  }

  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  if (scope === 'node') {
    return getNodeStructuralDiff(db, task, nodeRunId)
  }

  if (task.repoCount === 1) {
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute structural diff`,
        409,
      )
    }
    if (!existsSync(task.worktreePath)) {
      // Worktree GC'd — serve the eager-persisted artifact if we have one.
      const stored = await readStoredDiff(taskId, 'task')
      if (stored !== null) return stored
      throw new DomainError(
        'task-worktree-missing',
        `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
        410,
      )
    }
    const diff = await computeFromWorktree({
      taskId,
      scope,
      worktreePath: task.worktreePath,
      fromRef: task.baseCommit,
    })
    // Persist for terminal tasks so the view survives a later worktree GC.
    if (isTerminalTaskStatus(task.status)) void writeStoredDiff(diff)
    return diff
  }

  // Multi-repo: merge per-repo diffs, labeling files by repo dir.
  if (!existsSync(task.worktreePath)) {
    const stored = await readStoredDiff(taskId, 'task')
    if (stored !== null) return stored
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
      410,
    )
  }
  const usable = task.repos.filter(
    (r) => r.baseCommit !== null && r.baseCommit !== '' && existsSync(r.worktreePath),
  )
  if (usable.length === 0) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no repo with a recorded base commit; cannot compute structural diff`,
      409,
    )
  }
  const parts: Array<{ label: string; diff: StructuralDiff }> = []
  for (const repo of usable) {
    const diff = await computeFromWorktree({
      taskId,
      scope,
      worktreePath: repo.worktreePath,
      fromRef: repo.baseCommit as string,
    })
    parts.push({ label: repo.worktreeDirName || basename(repo.repoPath), diff })
  }
  const merged = mergeStructuralDiffs(
    {
      scope,
      taskId,
      fromRef: 'multi',
      toRef: 'WORKTREE',
      engine: 'baseline',
      status: usable.length === task.repos.length ? 'ok' : 'partial',
    },
    parts,
  )
  if (isTerminalTaskStatus(task.status)) void writeStoredDiff(merged)
  return merged
}

type ResolvedTask = NonNullable<Awaited<ReturnType<typeof getTask>>>

/** Per-node structural diff: what did this specific node run change? */
async function getNodeStructuralDiff(
  db: DbClient,
  task: ResolvedTask,
  nodeRunId: string | undefined,
): Promise<StructuralDiff> {
  if (nodeRunId === undefined || nodeRunId === '') {
    throw new ValidationError(
      'structural-node-run-required',
      `structural-diff scope 'node' requires a 'nodeRunId' query param`,
    )
  }
  if (task.repoCount !== 1) {
    // Multi-repo per-node snapshots live in pre_snapshot_repos_json — deferred.
    throw new ValidationError(
      'structural-node-scope-multi-repo-unsupported',
      `per-node structural diff is single-repo only in v1`,
    )
  }

  const rows = await db
    .select({
      id: nodeRuns.id,
      preSnapshot: nodeRuns.preSnapshot,
      startedAt: nodeRuns.startedAt,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, task.id))
    .orderBy(asc(nodeRuns.startedAt), asc(nodeRuns.id))

  const res = resolveNodeScope(rows, nodeRunId)
  if (res.kind === 'not-found') {
    throw new NotFoundError(
      'node-run-not-found',
      `node run '${nodeRunId}' not found in task '${task.id}'`,
    )
  }
  if (res.kind === 'readonly') {
    // Readonly / non-write node correctly contributes nothing.
    return emptyNodeDiff(task.id, nodeRunId, 'readonly-node-no-snapshot')
  }
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
      410,
    )
  }
  try {
    if (res.kind === 'between') {
      return await computeBetweenRefs({
        taskId: task.id,
        scope: 'node',
        nodeRunId,
        worktreePath: task.worktreePath,
        fromRef: res.fromRef,
        toRef: res.toRef,
      })
    }
    return await computeFromWorktree({
      taskId: task.id,
      scope: 'node',
      nodeRunId,
      worktreePath: task.worktreePath,
      fromRef: res.fromRef,
    })
  } catch {
    // Snapshot objects pruned by a post-GC `git gc` — surface gracefully.
    return emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned')
  }
}

function emptyNodeDiff(
  taskId: string,
  nodeRunId: string,
  degradedReason: string,
  status: StructuralDiff['status'] = 'ok',
): StructuralDiff {
  return {
    scope: 'node',
    taskId,
    nodeRunId,
    fromRef: '',
    toRef: '',
    engine: 'baseline',
    status,
    degradedReason,
    files: [],
    dependencyChanges: [],
    impact: [],
    summary: computeSummary([], []),
  }
}
