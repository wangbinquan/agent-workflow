// RFC-349 — SQLite row selection for worktree backup and reconstruction.
// The shared service owns only filesystem archive mechanics; this adapter is
// the sole owner of the synchronous Drizzle schema queries.

import { eq, inArray } from 'drizzle-orm'

import { LIVE_WORKTREE_TASK_STATUSES } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import {
  captureWorktreeRows,
  reconstructWorktreeRows,
  type WorktreeCaptureResult,
  type WorktreeReconstructResult,
} from '@/services/worktreeBackup'

export async function captureWorktrees(
  db: DbClient,
  stagingDirectory: string,
  options?: { readonly maxBytes?: number },
): Promise<WorktreeCaptureResult> {
  const rows = db
    .select({
      id: tasks.id,
      worktreePath: tasks.worktreePath,
      branch: tasks.branch,
      repoPath: tasks.repoPath,
      baseCommit: tasks.baseCommit,
    })
    .from(tasks)
    .where(inArray(tasks.status, [...LIVE_WORKTREE_TASK_STATUSES]))
    .all()
  return await captureWorktreeRows(rows, stagingDirectory, options)
}

export async function reconstructWorktrees(
  db: DbClient,
  extractedDirectory: string,
): Promise<WorktreeReconstructResult> {
  return await reconstructWorktreeRows(
    {
      findById(taskId) {
        return db
          .select({
            id: tasks.id,
            status: tasks.status,
            worktreePath: tasks.worktreePath,
            branch: tasks.branch,
            repoPath: tasks.repoPath,
          })
          .from(tasks)
          .where(eq(tasks.id, taskId))
          .get()
      },
    },
    extractedDirectory,
  )
}
