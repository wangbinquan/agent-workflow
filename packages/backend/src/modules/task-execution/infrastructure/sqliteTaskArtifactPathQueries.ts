import { and, eq, isNotNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { TaskArtifactPathQueries } from '../application/ports/taskArtifactPathQueries'
import { collectTaskArtifactPaths } from '../domain/taskArtifactPaths'

export class SqliteTaskArtifactPathQueries implements TaskArtifactPathQueries {
  constructor(private readonly db: DbClient) {}

  async forcedPaths(taskId: string): Promise<readonly string[]> {
    const task = this.db
      .select({ spaceKind: tasks.spaceKind, platformInputPathsJson: tasks.platformInputPathsJson })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    const rows = this.db
      .select({ archiveJson: nodeRunOutputs.archiveJson })
      .from(nodeRunOutputs)
      .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
      .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRunOutputs.archiveJson)))
      .all()
    return collectTaskArtifactPaths(task, rows)
  }
}
