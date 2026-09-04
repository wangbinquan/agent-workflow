// RFC-359 W1-T2c —— 评审互斥作用域（node_run → task）解析的一份实现，两个引擎共用。
// 替代 `sqliteReviewMutationScope.ts`（其同步 `findTaskIdSync` 入队捷径随之退役：两个
// provider 都在 async 查询之后进入同一个 per-task FIFO）。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns } from '@/db/schema'
import type { ReviewMutationScopeResolver } from '../application/ports/reviewMutationScope'

export class DatabaseReviewMutationScopeResolver implements ReviewMutationScopeResolver {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async findTaskId(nodeRunId: string): Promise<string | null> {
    const row = (
      await this.db
        .select({ taskId: nodeRuns.taskId })
        .from(nodeRuns)
        .where(eq(nodeRuns.id, nodeRunId))
        .limit(1)
    )[0]
    return row?.taskId ?? null
  }
}
