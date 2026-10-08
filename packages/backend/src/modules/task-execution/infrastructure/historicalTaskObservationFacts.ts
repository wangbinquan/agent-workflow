import { and, asc, eq, gt } from 'drizzle-orm'
import {
  NodeKindSchema,
  RuntimeStatusEntrySchema,
  type HistoricalObservationOwnerQuery,
  type HistoricalObservationEvent,
} from '@agent-workflow/shared'
import type { ProviderNeutralDatabase } from '@/db/query'
import { nodeRuns, nodeRunEvents, tasks } from '@/db/schema'

const object = (raw: string | null): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(raw ?? 'null')
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}
const text = (value: unknown) => (typeof value === 'string' && value.length > 0 ? value : null)
const count = (value: number | null) =>
  value !== null && Number.isSafeInteger(value) && value >= 0 ? String(value) : null

/** Whole original NodeRun population, including soft-deleted Tasks and unknown execution times. */
export function createHistoricalTaskObservationFacts(
  db: ProviderNeutralDatabase,
): HistoricalObservationOwnerQuery {
  return {
    async owners(input) {
      const rows = await db
        .select({
          run: nodeRuns,
          task: { id: tasks.id, name: tasks.name, snapshot: tasks.workflowSnapshot },
        })
        .from(nodeRuns)
        .leftJoin(tasks, eq(tasks.id, nodeRuns.taskId))
        .where(input.after === undefined ? undefined : gt(nodeRuns.id, input.after))
        .orderBy(asc(nodeRuns.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map(({ run, task }) => {
          const frozen = object(task?.snapshot ?? null),
            nodes = Array.isArray(frozen.nodes) ? frozen.nodes : []
          const matches = nodes.filter(
            (node): node is Record<string, unknown> =>
              node !== null && typeof node === 'object' && 'id' in node && node.id === run.nodeId,
          )
          const original = matches.length === 1 ? matches[0]! : {},
            overrideId = text(run.agentOverrideId),
            overrideName = text(run.agentOverrideName),
            hasOverride = overrideId !== null || overrideName !== null,
            agentId = hasOverride ? overrideId : text(original.agentId)
          const protocol = RuntimeStatusEntrySchema.shape.protocol.safeParse(run.runtime),
            kind = NodeKindSchema.safeParse(original.kind),
            computeKind =
              run.spawnBinaryPath !== null || run.opencodeSessionId !== null
                ? ('agent' as const)
                : !kind.success
                  ? ('unknown' as const)
                  : kind.data === 'agent-single' || kind.data === 'code-round'
                    ? ('agent' as const)
                    : ('non-agent' as const)
          const recordedUsage = {
            input: count(run.tokInput),
            cacheRead: count(run.tokCacheRead),
            cacheWrite: count(run.tokCacheCreate),
            output: count(run.tokOutput),
          }
          return {
            kind: 'historical-observed' as const,
            referenceId: JSON.stringify(['historical-observed', 'task', run.id]),
            sourceKind: 'task' as const,
            ownerId: run.id,
            attemptId: run.id,
            nodeRunId: run.id,
            parentTaskId: run.taskId,
            name: task?.name ?? run.nodeId,
            status: run.status,
            computeKind,
            createdAt: null,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            agentId,
            agentRevision: null,
            agentName: hasOverride ? overrideName : text(original.agentName),
            purpose: 'task' as const,
            runtime: protocol.success
              ? {
                  registrationId: null,
                  configurationRevision: null,
                  protocol: protocol.data,
                  name: null,
                }
              : null,
            rootSessionId: run.opencodeSessionId,
            recordedUsage: Object.values(recordedUsage).some((value) => value !== null)
              ? recordedUsage
              : null,
          }
        }),
        nextCursor: rows.length > input.limit ? selected.at(-1)!.run.id : null,
      }
    },
    async events(ownerId, input) {
      const after = input.after === undefined ? undefined : Number(input.after)
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0))
        throw new RangeError('Invalid original node event cursor')
      const rows = await db
        .select({
          id: nodeRunEvents.id,
          sessionId: nodeRunEvents.sessionId,
          parentSessionId: nodeRunEvents.parentSessionId,
          occurredAt: nodeRunEvents.ts,
          payload: nodeRunEvents.payload,
        })
        .from(nodeRunEvents)
        .where(
          and(
            eq(nodeRunEvents.nodeRunId, ownerId),
            after === undefined ? undefined : gt(nodeRunEvents.id, after),
          ),
        )
        .orderBy(asc(nodeRunEvents.id))
        .limit(input.limit + 1)
        .all()
      const selected = rows.slice(0, input.limit)
      return {
        items: selected.map((row): HistoricalObservationEvent => {
          const event = object(row.payload),
            part =
              event.part !== null && typeof event.part === 'object'
                ? (event.part as Record<string, unknown>)
                : {}
          return {
            id: String(row.id),
            attemptId: ownerId,
            sessionId: row.sessionId,
            parentSessionId: row.parentSessionId,
            stepId: part.type === 'step-finish' ? text(part.id) : null,
            occurredAt: row.occurredAt,
          }
        }),
        nextCursor: rows.length > input.limit ? String(selected.at(-1)!.id) : null,
      }
    },
  }
}
