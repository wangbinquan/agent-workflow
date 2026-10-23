// RFC-359 W57 —— 「这些 node_run 里，哪些已经产出过 output」：**一份**，协作模块内共用。
//
// 此前 `taskQuestionDispatch.ts` / `taskQuestions.ts` / `clarify/queue.ts` 各存一份**逐字相同**
// 的私有 `runIdsWithOutput`（连签名都一样），合计十个调用点。它是「这一轮问答该不该重跑上游」
// 的判据之一，三份实现意味着三条问答路径可能对同一批 run 给出不同答案。

import { createNodeOutputQueries } from '@/modules/task-execution/public/queries'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
/** 空入参不查库；返回的是**存在 output 的那一子集**。 */
export async function runIdsWithOutput(db: PersistenceDb, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()

  const rows = await createNodeOutputQueries(db)
    .runsWithOutput(runIds)
    .then((runIds) => [...runIds].map((nodeRunId) => ({ nodeRunId })))
    .then((rows) => rows.map((row) => ({ nodeRunId: row.nodeRunId })))
  return new Set(rows.map((r) => r.nodeRunId))
}
