import { and, eq, isNotNull } from 'drizzle-orm'

import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { TaskArtifactPathQueries } from '../application/ports/taskArtifactPathQueries'
import { collectTaskArtifactPaths } from '../domain/taskArtifactPaths'

export class PostgresqlTaskArtifactPathQueries implements TaskArtifactPathQueries {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async forcedPaths(taskId: string): Promise<readonly string[]> {
    const taskRows = await this.db
      .select({ spaceKind: tasks.spaceKind, platformInputPathsJson: tasks.platformInputPathsJson })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
    const rows = await this.db
      .select({ archiveJson: nodeRunOutputs.archiveJson })
      .from(nodeRunOutputs)
      .innerJoin(nodeRuns, eq(nodeRunOutputs.nodeRunId, nodeRuns.id))
      .where(and(eq(nodeRuns.taskId, taskId), isNotNull(nodeRunOutputs.archiveJson)))
    return collectTaskArtifactPaths(taskRows[0], rows)
  }
}
