import { and, count, desc, eq, inArray, isNotNull } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import {
  taskCollaborators,
  tasks,
  webhookDeliveries,
  webhookMrControlEffects,
  webhookMrControlTargets,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { WebhookDeliveryQueries } from '../application/ports/webhookDeliveryQueries'

/** PostgreSQL twin of the delivery audit/replay read model. */
export function createPostgresqlWebhookDeliveryQueries(
  db: PostgresqlDatabaseClient,
): WebhookDeliveryQueries {
  const queries: WebhookDeliveryQueries = {
    async page(input) {
      const conditions = [
        ...(input.endpointId === undefined
          ? []
          : [eq(webhookDeliveries.endpointId, input.endpointId)]),
        ...(input.status === undefined ? [] : [eq(webhookDeliveries.status, input.status)]),
        ...(input.eventType === undefined
          ? []
          : [eq(webhookDeliveries.eventType, input.eventType)]),
        ...(input.repoPath === undefined ? [] : [eq(webhookDeliveries.repoPath, input.repoPath)]),
      ]
      const where = conditions.length === 0 ? undefined : and(...conditions)
      const total =
        (await db.select({ count: count() }).from(webhookDeliveries).where(where))[0]?.count ?? 0
      const offset = (input.page - 1) * input.limit
      const items =
        offset >= total
          ? []
          : await db
              .select({
                id: webhookDeliveries.id,
                endpointId: webhookDeliveries.endpointId,
                eventUuid: webhookDeliveries.eventUuid,
                attemptCount: webhookDeliveries.attemptCount,
                gitlabEventHeader: webhookDeliveries.gitlabEventHeader,
                objectKind: webhookDeliveries.objectKind,
                eventType: webhookDeliveries.eventType,
                repoPath: webhookDeliveries.repoPath,
                streamHint: webhookDeliveries.streamHint,
                status: webhookDeliveries.status,
                statusReason: webhookDeliveries.statusReason,
                replayedFromDeliveryId: webhookDeliveries.replayedFromDeliveryId,
                receivedAt: webhookDeliveries.receivedAt,
              })
              .from(webhookDeliveries)
              .where(where)
              .orderBy(desc(webhookDeliveries.receivedAt), desc(webhookDeliveries.id))
              .limit(input.limit)
              .offset(offset)
      return {
        items,
        total,
        page: input.page,
        pageCount: Math.max(1, Math.ceil(total / input.limit)),
      }
    },
    async listRepoPaths() {
      const rows = await db
        .selectDistinct({ repoPath: webhookDeliveries.repoPath })
        .from(webhookDeliveries)
        .where(isNotNull(webhookDeliveries.repoPath))
        .orderBy(webhookDeliveries.repoPath)
      return rows.flatMap((row) => (row.repoPath === null ? [] : [row.repoPath]))
    },
    async get(id) {
      return (
        (await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).get()) ??
        null
      )
    },
    async terminalControl(deliveryId, actor) {
      const effect = await db
        .select()
        .from(webhookMrControlEffects)
        .where(eq(webhookMrControlEffects.deliveryId, deliveryId))
        .get()
      if (effect === undefined) return null
      const targetRows = await db
        .select()
        .from(webhookMrControlTargets)
        .where(eq(webhookMrControlTargets.effectId, effect.id))
      const taskIds = targetRows.map((target) => target.taskId)
      const taskRows =
        taskIds.length === 0
          ? []
          : await db
              .select({
                id: tasks.id,
                ownerUserId: tasks.ownerUserId,
                status: tasks.status,
                spaceKind: tasks.spaceKind,
                workspacePruningAt: tasks.workspacePruningAt,
                workspacePrunedAt: tasks.workspacePrunedAt,
              })
              .from(tasks)
              .where(inArray(tasks.id, taskIds))
      const membershipIds =
        actor.permissions.has('tasks:read:all') || actor.user.id === SYSTEM_USER_ID
          ? new Set(taskIds)
          : new Set(
              (taskIds.length === 0
                ? []
                : await db
                    .select({ taskId: taskCollaborators.taskId })
                    .from(taskCollaborators)
                    .where(
                      and(
                        inArray(taskCollaborators.taskId, taskIds),
                        eq(taskCollaborators.userId, actor.user.id),
                      ),
                    )
              ).map((row) => row.taskId),
            )
      const tasksById = new Map(taskRows.map((task) => [task.id, task] as const))
      const visibleTargets = []
      let hiddenTargetCount = 0
      for (const target of targetRows) {
        const task = tasksById.get(target.taskId)
        const visible =
          task !== undefined &&
          (actor.permissions.has('tasks:read:all') ||
            task.ownerUserId === actor.user.id ||
            (task.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) ||
            membershipIds.has(target.taskId))
        if (!visible || task === undefined) {
          hiddenTargetCount += 1
          continue
        }
        visibleTargets.push({
          taskId: target.taskId,
          priorStatus: target.priorStatus ?? '',
          currentStatus: task.status,
          fenceOutcome: target.fenceOutcome,
          cancelOutcome: target.cancelOutcome,
          releaseOutcome: target.releaseOutcome,
          error: target.error,
          workspace: {
            spaceKind: task.spaceKind,
            state:
              task.workspacePrunedAt !== null
                ? ('pruned' as const)
                : task.workspacePruningAt !== null
                  ? ('pruning' as const)
                  : ('retained' as const),
          },
        })
      }
      return {
        kind: effect.kind,
        observedEventType: effect.observedEventType,
        status: effect.status,
        revision: effect.revision,
        attemptCount: effect.attemptCount,
        lastError: effect.lastError,
        totalTargetCount: targetRows.length,
        hiddenTargetCount,
        targets: visibleTargets,
      }
    },
    async hasTerminalControlEffect(deliveryId) {
      return (
        (await db
          .select({ id: webhookMrControlEffects.id })
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.deliveryId, deliveryId))
          .get()) !== undefined
      )
    },
  }
  return Object.freeze(queries)
}
