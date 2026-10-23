import { asc, inArray } from 'drizzle-orm'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'

export interface NodeEventContent {
  readonly id: number
  readonly nodeRunId: string
  readonly ts: number
  readonly kind: string
  readonly payload: string
  readonly sessionId: string | null
  readonly parentSessionId: string | null
}

/** 蒸馏按事件时间、稳定主键读取正文，不暴露存储行。 */
export async function listNodeEventContents(
  db: PersistenceDb,
  ids: readonly string[],
): Promise<NodeEventContent[]> {
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
