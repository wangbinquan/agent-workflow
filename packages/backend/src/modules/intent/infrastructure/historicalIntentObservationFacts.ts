import { and, asc, eq, gt } from 'drizzle-orm'
import {
  RuntimeStatusEntrySchema,
  type HistoricalObservationOwnerQuery,
  type HistoricalObservationEvent,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { intentSessions, intentTurns, intentTurnEvents } from '@/db/schema'

function originalObject(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
/** Agent turns and their original roots are never manufactured as Task or NodeRun rows. */
export function createHistoricalIntentObservationFacts(
  db: ProviderNeutralDatabase,
): HistoricalObservationOwnerQuery {
  return {
    async owners(input) {
      const rows = await db
        .select({
          id: intentTurns.id,
          sessionId: intentTurns.sessionId,
          status: intentTurns.kind,
          createdAt: intentTurns.createdAt,
          rootSessionId: intentTurns.captureRootSessionId,
          runMeta: intentTurns.runMetaJson,
          ownerUserId: intentSessions.ownerUserId,
        })
        .from(intentTurns)
        .leftJoin(intentSessions, eq(intentSessions.id, intentTurns.sessionId))
        .where(
          and(
            eq(intentTurns.role, 'agent'),
            input.after === undefined ? undefined : gt(intentTurns.id, input.after),
          ),
        )
        .orderBy(asc(intentTurns.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map((row) => {
          const meta = originalObject(row.runMeta),
            protocol = RuntimeStatusEntrySchema.shape.protocol.safeParse(meta.runtime)
          return {
            kind: 'historical-observed' as const,
            referenceId: JSON.stringify(['historical-observed', 'intent-turn', row.id]),
            sourceKind: 'intent-turn' as const,
            ownerId: row.id,
            attemptId: row.id,
            nodeRunId: null,
            parentTaskId: null,
            ownerUserId: row.ownerUserId,
            name: '意图生成',
            status:
              row.status === 'error' ? 'failed' : row.status === 'running' ? 'running' : 'done',
            originalStatus: row.status,
            createdAt: row.createdAt,
            startedAt: null,
            finishedAt: null,
            agentId: null,
            agentRevision: null,
            agentName: null,
            purpose: 'system' as const,
            runtime: protocol.success
              ? {
                  registrationId: null,
                  configurationRevision: null,
                  protocol: protocol.data,
                  name: null,
                }
              : null,
            rootSessionId: row.rootSessionId,
            recordedUsage: null,
          }
        }),
        nextCursor: rows.length > input.limit ? selected.at(-1)!.id : null,
      }
    },
    async events(ownerId, input) {
      const after = input.after === undefined ? undefined : Number(input.after)
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
        throw new RangeError('Invalid original Intent event cursor')
      const rows = await db
        .select({
          id: intentTurnEvents.id,
          sessionId: intentTurnEvents.sessionId,
          parentSessionId: intentTurnEvents.parentSessionId,
          occurredAt: intentTurnEvents.ts,
          payload: intentTurnEvents.payload,
        })
        .from(intentTurnEvents)
        .where(
          and(
            eq(intentTurnEvents.turnId, ownerId),
            after === undefined ? undefined : gt(intentTurnEvents.id, after),
          ),
        )
        .orderBy(asc(intentTurnEvents.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map((row): HistoricalObservationEvent => {
          const event = originalObject(row.payload),
            part =
              event.part !== null && typeof event.part === 'object'
                ? (event.part as Record<string, unknown>)
                : {}
          return {
            id: String(row.id),
            attemptId: ownerId,
            sessionId: row.sessionId,
            parentSessionId: row.parentSessionId,
            stepId:
              part.type === 'step-finish' && typeof part.id === 'string' && part.id.length > 0
                ? part.id
                : null,
            occurredAt: row.occurredAt,
          }
        }),
        nextCursor: rows.length > input.limit ? String(selected.at(-1)!.id) : null,
      }
    },
  }
}
