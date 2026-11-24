import { asc, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { TaskDistillationEvent } from '../application/ports/taskKnowledgeQueries'

/**
 * 蒸馏按事件时间、稳定主键读取正文，不暴露存储行。RFC-565：模块外经 `TaskKnowledgeQueries.distillationEvents` 读，本函数只在
 * 模块内用。
 */
export async function listNodeEventContents(
  db: PersistenceDb,
  ids: readonly string[],
): Promise<TaskDistillationEvent[]> {
  if (ids.length === 0) return []
  const { nodeRunEvents } = tablesOf(db)
  return db
    .select({
      id: nodeRunEvents.id,
      nodeRunId: nodeRunEvents.nodeRunId,
      ts: nodeRunEvents.ts,
      kind: nodeRunEvents.kind,
      payload: nodeRunEvents.payload,
      sessionId: nodeRunEvents.sessionId,
      parentSessionId: nodeRunEvents.parentSessionId,
    })
    .from(nodeRunEvents)
    .where(inArray(nodeRunEvents.nodeRunId, [...ids]))
    .orderBy(asc(nodeRunEvents.ts), asc(nodeRunEvents.id))
}
