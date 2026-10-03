import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Paths } from '@/util/paths'
import type { TaskDeletionContentEffects } from '../../application/ports/taskDeletionContentEffects'

export function createFileTaskDeletionContentEffects(): TaskDeletionContentEffects {
  return Object.freeze({
    directories(taskId: string): readonly [string, string, string] {
      return [
        join(Paths.runsDir, taskId),
        join(Paths.logsDir, taskId),
        join(Paths.root, 'scratch', taskId),
      ]
    },
    removeIfPresent(reference: string): void {
      if (existsSync(reference)) rmSync(reference, { recursive: true, force: true })
    },
  })
}
