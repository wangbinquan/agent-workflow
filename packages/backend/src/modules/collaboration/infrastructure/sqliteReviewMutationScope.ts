import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import type { ReviewMutationScopeResolver } from '../application/ports/reviewMutationScope'

export class SqliteReviewMutationScopeResolver implements ReviewMutationScopeResolver {
  constructor(private readonly db: DbClient) {}

  findTaskIdSync(nodeRunId: string): string | null {
    const row = this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
      .get()
    return row?.taskId ?? null
  }

  async findTaskId(nodeRunId: string): Promise<string | null> {
    return this.findTaskIdSync(nodeRunId)
  }
}
