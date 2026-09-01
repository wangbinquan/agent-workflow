import { eq } from 'drizzle-orm'

import { nodeRuns } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ReviewMutationScopeResolver } from '../application/ports/reviewMutationScope'

export class PostgresqlReviewMutationScopeResolver implements ReviewMutationScopeResolver {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async findTaskId(nodeRunId: string): Promise<string | null> {
    const rows = await this.db
      .select({ taskId: nodeRuns.taskId })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return rows[0]?.taskId ?? null
  }
}
