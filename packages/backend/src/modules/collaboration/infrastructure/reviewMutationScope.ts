// RFC-359 W1-T2c —— 评审互斥作用域（node_run → task）解析的一份实现，两个引擎共用。
// 替代 `sqliteReviewMutationScope.ts`（其同步 `findTaskIdSync` 入队捷径随之退役：两个
// provider 都在 async 查询之后进入同一个 per-task FIFO）。

import { createNodeRunQueries } from '@/modules/task-execution/public/queries'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ReviewMutationScopeResolver } from '../application/ports/reviewMutationScope'

export class DatabaseReviewMutationScopeResolver implements ReviewMutationScopeResolver {
  constructor(private readonly db: PersistenceDb) {}

  async findTaskId(nodeRunId: string): Promise<string | null> {
    const row = await createNodeRunQueries(this.db).readFields(nodeRunId, ['taskId'])
    return row?.taskId ?? null
  }
}
