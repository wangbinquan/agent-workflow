import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Paths } from '@/util/paths'
import type { TaskDeletionContentEffects } from '../../application/ports/taskDeletionContentEffects'

export function createFileTaskDeletionContentEffects(): TaskDeletionContentEffects {
  return Object.freeze({
    directories(taskId: string): readonly string[] {
      return [
        join(Paths.runsDir, taskId),
        join(Paths.logsDir, taskId),
        join(Paths.root, 'scratch', taskId),
        // RFC-370 §10 V16: the task's code-review artifacts (structural diffs,
        // change narrative) were never removed with the task.
        join(Paths.root, 'structural-diffs', taskId),
      ]
    },
    removeIfPresent(reference: string): void {
      if (existsSync(reference)) rmSync(reference, { recursive: true, force: true })
    },
  })
}
