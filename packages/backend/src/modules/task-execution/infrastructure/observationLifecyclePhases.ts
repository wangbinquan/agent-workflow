import { and, asc, eq, gt } from 'drizzle-orm'
import type { ProviderNeutralDatabase } from '@/db/query'
import { docVersions, clarifyRounds, tasks } from '@/db/schema'
import type { ObservationPhase } from '@agent-workflow/shared'
/** Original owner timestamps only; absence of a lifecycle clock is never converted into a queue/model interval. */
export function originalObservationLifecyclePhases(db: ProviderNeutralDatabase) {
  return async (taskId: string, input: { after?: string; limit: number }) => {
    const task = await db
      .select({ status: tasks.status })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .get()
    if (!task) return { items: [], nextCursor: null }
    const stage = input.after?.startsWith('clarify/') ? 'clarify' : 'review',
      after = input.after?.slice(stage.length + 1),
      items: ObservationPhase[] = []
    if (stage === 'review') {
      const rows = await db
        .select({
          id: docVersions.id,
          nodeRunId: docVersions.reviewNodeRunId,
          createdAt: docVersions.createdAt,
          endedAt: docVersions.decidedAt,
          decision: docVersions.decision,
        })
        .from(docVersions)
        .where(and(eq(docVersions.taskId, taskId), after ? gt(docVersions.id, after) : undefined))
        .orderBy(asc(docVersions.id))
        .limit(input.limit + 1)
        .all()
      for (const row of rows.slice(0, input.limit))
        items.push({
          id: 'review/' + row.id,
          taskId,
          nodeRunId: row.nodeRunId,
          kind: 'human-wait',
          basis: 'review-round',
          startedAt: row.createdAt,
          endedAt: row.endedAt,
          status:
            row.endedAt !== null
              ? 'closed'
              : row.decision === 'pending' &&
                  ['awaiting_review', 'awaiting_human'].includes(task.status)
                ? 'active'
                : 'unknown',
          evidenceId: row.id,
          label: 'review',
        })
      return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : 'clarify/' }
    }
    const rows = await db
      .select({
        id: clarifyRounds.id,
        nodeRunId: clarifyRounds.askingNodeRunId,
        createdAt: clarifyRounds.createdAt,
        endedAt: clarifyRounds.answeredAt,
        status: clarifyRounds.status,
      })
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.taskId, taskId), after ? gt(clarifyRounds.id, after) : undefined))
      .orderBy(asc(clarifyRounds.id))
      .limit(input.limit + 1)
      .all()
    for (const row of rows.slice(0, input.limit))
      items.push({
        id: 'clarify/' + row.id,
        taskId,
        nodeRunId: row.nodeRunId,
        kind: 'human-wait',
        basis: 'clarify-round',
        startedAt: row.createdAt,
        endedAt: row.endedAt,
        status:
          row.endedAt !== null
            ? 'closed'
            : row.status === 'awaiting_human' && task.status === 'awaiting_human'
              ? 'active'
              : 'unknown',
        evidenceId: row.id,
        label: 'clarify',
      })
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.id : null }
  }
}
