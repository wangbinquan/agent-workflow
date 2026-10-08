import { and, asc, eq, gt } from 'drizzle-orm'
import type {
  HistoricalObservationOwnerQuery,
  HistoricalObservationEvent,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { memoryDistillEvents, memoryDistillJobs } from '@/db/schema'

function originalStep(payload: string): string | null {
  try {
    const event: unknown = JSON.parse(payload)
    if (event === null || typeof event !== 'object' || !('part' in event)) return null
    const part = event.part
    return part !== null &&
      typeof part === 'object' &&
      'type' in part &&
      part.type === 'step-finish' &&
      'id' in part &&
      typeof part.id === 'string' &&
      part.id.length > 0
      ? part.id
      : null
  } catch {
    return null
  }
}
/** Every job and every original attempt event is retained; a newer System group never hides old attempts. */
export function createHistoricalMemoryObservationFacts(
  db: ProviderNeutralDatabase,
): HistoricalObservationOwnerQuery {
  return {
    async owners(input) {
      const rows = await db
        .select({
          id: memoryDistillJobs.id,
          sourceKind: memoryDistillJobs.sourceKind,
          taskId: memoryDistillJobs.taskId,
          status: memoryDistillJobs.status,
          createdAt: memoryDistillJobs.createdAt,
          startedAt: memoryDistillJobs.startedAt,
          finishedAt: memoryDistillJobs.finishedAt,
          rootSessionId: memoryDistillJobs.opencodeSessionId,
        })
        .from(memoryDistillJobs)
        .where(input.after === undefined ? undefined : gt(memoryDistillJobs.id, input.after))
        .orderBy(asc(memoryDistillJobs.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map((row) => ({
          kind: 'historical-observed' as const,
          referenceId: JSON.stringify(['historical-observed', 'memory-distill', row.id]),
          sourceKind: 'memory-distill' as const,
          ownerId: row.id,
          attemptId: null,
          nodeRunId: null,
          parentTaskId: row.taskId,
          name: '记忆提取 · ' + row.sourceKind,
          status: row.status,
          createdAt: row.createdAt,
          startedAt: row.startedAt,
          finishedAt: row.finishedAt,
          agentId: null,
          agentRevision: null,
          agentName: null,
          purpose: 'memory' as const,
          runtime: null,
          rootSessionId: row.rootSessionId,
          recordedUsage: null,
        })),
        nextCursor: rows.length > input.limit ? selected.at(-1)!.id : null,
      }
    },
    async events(ownerId, input) {
      const after = input.after === undefined ? undefined : Number(input.after)
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
        throw new RangeError('Invalid original memory event cursor')
      const rows = await db
        .select({
          id: memoryDistillEvents.id,
          attemptIndex: memoryDistillEvents.attemptIndex,
          sessionId: memoryDistillEvents.sessionId,
          parentSessionId: memoryDistillEvents.parentSessionId,
          occurredAt: memoryDistillEvents.ts,
          payload: memoryDistillEvents.payload,
        })
        .from(memoryDistillEvents)
        .where(
          and(
            eq(memoryDistillEvents.distillJobId, ownerId),
            after === undefined ? undefined : gt(memoryDistillEvents.id, after),
          ),
        )
        .orderBy(asc(memoryDistillEvents.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map(
          (row): HistoricalObservationEvent => ({
            id: String(row.id),
            attemptId: String(row.attemptIndex),
            sessionId: row.sessionId === '(unknown)' ? null : row.sessionId,
            parentSessionId: row.parentSessionId,
            stepId: originalStep(row.payload),
            occurredAt: row.occurredAt,
          }),
        ),
        nextCursor: rows.length > input.limit ? String(selected.at(-1)!.id) : null,
      }
    },
  }
}
