import { taskContentDirectory } from '@/platform/content/locations/directories'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Paths } from '@/util/paths'
import type { TaskDeletionContentEffects } from '../../application/ports/taskDeletionContentEffects'

export function createFileTaskDeletionContentEffects(): TaskDeletionContentEffects {
  return Object.freeze({
    directories(taskId: string): readonly string[] {
      return [
        taskContentDirectory(Paths.runsDir, taskId),
        taskContentDirectory(Paths.logsDir, taskId),
        taskContentDirectory(join(Paths.root, 'scratch'), taskId),
        // RFC-370 §10 V16: the task's code-review artifacts (structural diffs,
        // change narrative) were never removed with the task.
        taskContentDirectory(join(Paths.root, 'structural-diffs'), taskId),
      ]
    },
    removeIfPresent(reference: string): void {
      if (existsSync(reference)) rmSync(reference, { recursive: true, force: true })
    },
  })
}
