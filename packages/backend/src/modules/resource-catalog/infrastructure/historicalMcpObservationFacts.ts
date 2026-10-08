import { and, asc, eq, gt } from 'drizzle-orm'
import type {
  HistoricalObservationOwnerQuery,
  HistoricalObservationEvent,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { mcpRuntimeTestSessions, mcpRuntimeTestTurns, mcpRuntimeTestEvents } from '@/db/schema'

function stepId(payload: string): string | null {
  try {
    const value: unknown = JSON.parse(payload)
    if (value === null || typeof value !== 'object' || !('part' in value)) return null
    const part = value.part
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
/** Actual turn boundaries and all first-seen events, including a resumed multi-turn session. */
export function createHistoricalMcpObservationFacts(
  db: ProviderNeutralDatabase,
): HistoricalObservationOwnerQuery {
  return {
    async owners(input) {
      const rows = await db
        .select({
          turn: mcpRuntimeTestTurns,
          session: {
            id: mcpRuntimeTestSessions.id,
            ownerUserId: mcpRuntimeTestSessions.ownerUserId,
            runtimeRowId: mcpRuntimeTestSessions.runtimeRowId,
            runtimeName: mcpRuntimeTestSessions.runtimeName,
            protocol: mcpRuntimeTestSessions.runtimeProtocol,
            rootSessionId: mcpRuntimeTestSessions.runtimeSessionId,
          },
        })
        .from(mcpRuntimeTestTurns)
        .leftJoin(
          mcpRuntimeTestSessions,
          eq(mcpRuntimeTestSessions.id, mcpRuntimeTestTurns.sessionId),
        )
        .where(input.after === undefined ? undefined : gt(mcpRuntimeTestTurns.id, input.after))
        .orderBy(asc(mcpRuntimeTestTurns.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map(({ turn, session }) => ({
          kind: 'historical-observed' as const,
          referenceId: JSON.stringify(['historical-observed', 'mcp-runtime-test', turn.id]),
          sourceKind: 'mcp-runtime-test' as const,
          ownerId: turn.id,
          attemptId: turn.id,
          nodeRunId: null,
          parentTaskId: null,
          ownerUserId: session?.ownerUserId ?? null,
          name: 'MCP 会话',
          status: turn.status === 'succeeded' ? 'done' : turn.status,
          originalStatus: turn.status,
          createdAt: turn.createdAt,
          startedAt: turn.startedAt,
          finishedAt: turn.finishedAt,
          agentId: null,
          agentRevision: null,
          agentName: null,
          purpose: 'playground' as const,
          runtime: session
            ? {
                registrationId: session.runtimeRowId,
                configurationRevision: null,
                protocol: session.protocol,
                name: session.runtimeName,
              }
            : null,
          rootSessionId: session?.rootSessionId ?? null,
          recordedUsage: null,
        })),
        nextCursor: rows.length > input.limit ? selected.at(-1)!.turn.id : null,
      }
    },
    async events(ownerId, input) {
      const after = input.after === undefined ? undefined : Number(input.after)
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
        throw new RangeError('Invalid original MCP event cursor')
      const rows = await db
        .select({
          id: mcpRuntimeTestEvents.id,
          sessionId: mcpRuntimeTestEvents.sessionId,
          parentSessionId: mcpRuntimeTestEvents.parentSessionId,
          occurredAt: mcpRuntimeTestEvents.ts,
          payload: mcpRuntimeTestEvents.payload,
        })
        .from(mcpRuntimeTestEvents)
        .where(
          and(
            eq(mcpRuntimeTestEvents.firstSeenTurnId, ownerId),
            after === undefined ? undefined : gt(mcpRuntimeTestEvents.id, after),
          ),
        )
        .orderBy(asc(mcpRuntimeTestEvents.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map(
          (row): HistoricalObservationEvent => ({
            id: String(row.id),
            attemptId: ownerId,
            sessionId: row.sessionId,
            parentSessionId: row.parentSessionId,
            stepId: stepId(row.payload),
            occurredAt: row.occurredAt,
          }),
        ),
        nextCursor: rows.length > input.limit ? String(selected.at(-1)!.id) : null,
      }
    },
  }
}
