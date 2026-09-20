import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { cleanupRecordedWorktree } from '@/util/git'
import {
  WorktreePreparationEvidenceSchema,
  verifyExistingWorktree,
} from './journaledWorktreeMaterializer'
import type { WorkspaceCleanupHookEvent, WorkspaceCleanupReport } from './workspaceMaterializer'

/** Replays physical cleanup using the first preparation operands. No Task is
 * read here: the caller must retain its original unbound-workspace ownership. */
export async function cleanupRepositoryPreparationWorktrees(input: {
  readonly taskId: string
  readonly appHome: string
  readonly group: boolean
  readonly evidenceJson: string | null
  readonly assertCurrent: () => Promise<void>
  readonly hook?: (event: WorkspaceCleanupHookEvent) => void | Promise<void>
}): Promise<WorkspaceCleanupReport> {
  const evidence =
    input.evidenceJson === null
      ? { worktrees: [] }
      : WorktreePreparationEvidenceSchema.parse(JSON.parse(input.evidenceJson))
  const failures: WorkspaceCleanupReport['failures'] = []
  for (const { intent } of [...evidence.worktrees].reverse()) {
    await input.assertCurrent()
    const event = {
      taskId: input.taskId,
      path: intent.worktreePath,
      repoPath: intent.repoPath,
      branch: intent.branch,
    }
    // If another operation changed/replaced this tree, leave its contents intact.
    // An absent path is the expected crash window between remove and ref restore.
    if (existsSync(intent.worktreePath)) {
      try {
        await verifyExistingWorktree(intent)
      } catch (error) {
        failures.push({
          ...event,
          stage: 'worktree-remove',
          message: error instanceof Error ? error.message : String(error),
        })
        continue
      }
    }
    const result = await cleanupRecordedWorktree(intent, {
      async beforeStage(stage) {
        await input.assertCurrent()
        await input.hook?.({ ...event, stage })
        await input.assertCurrent()
      },
    })
    // A changed owner must propagate, not be mistaken for a completed cleanup.
    await input.assertCurrent()
    for (const failure of result.failures) failures.push({ ...event, ...failure })
    if (result.worktreeRemoved && existsSync(intent.worktreePath))
      failures.push({
        ...event,
        stage: 'worktree-remove',
        message: 'unregistered preparation path remains',
      })
  }
  // A group container is wholly preparation-owned until Task admission. Never
  // remove it while any member was retained after a conflict or failed remove.
  if (input.group && failures.length === 0) {
    const path = join(input.appHome, 'worktrees', 'group', input.taskId)
    await input.assertCurrent()
    await input.hook?.({ stage: 'owned-root-remove', taskId: input.taskId, path })
    await input.assertCurrent()
    try {
      await rm(path, { recursive: true, force: true })
    } catch (error) {
      if (existsSync(path))
        failures.push({
          stage: 'owned-root-remove',
          taskId: input.taskId,
          path,
          message: error instanceof Error ? error.message : String(error),
        })
    }
  }
  await input.assertCurrent()
  return { taskId: input.taskId, complete: failures.length === 0, failures }
}
