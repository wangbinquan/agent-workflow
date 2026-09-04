// RFC-359 W4-B1 —— 任务工件路径查询：一份实现，两个 provider 共用（此前 sqlite / postgresql 两份只差客户端类型与同步 / 异步形态）。

import { and, eq, isNotNull } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'

import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { TaskArtifactPathQueries } from '../application/ports/taskArtifactPathQueries'
import { collectTaskArtifactPaths } from '../domain/taskArtifactPaths'

export class DrizzleTaskArtifactPathQueries implements TaskArtifactPathQueries {
  constructor(private readonly db: ProviderNeutralDatabase) {}

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
