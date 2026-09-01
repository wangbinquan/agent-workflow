import { and, desc, eq, inArray, sql } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import {
  taskCollaborators,
  tasks,
  webhookDeliveries,
  webhookMrControlEffects,
  webhookMrControlTargets,
} from '@/db/schema'
import type { WebhookDeliveryQueries } from '../application/ports/webhookDeliveryQueries'

export function createSqliteWebhookDeliveryQueries(db: DbClient): WebhookDeliveryQueries {
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
        (
          await db
            .select({ count: sql<number>`count(*)` })
            .from(webhookDeliveries)
            .where(where)
        )[0]?.count ?? 0
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
      // Loose index scan over the (repo_path, received_at) index: K distinct
      // repositories cost K index seeks instead of rescanning millions of
      // retained deliveries on every filter-options refresh.
      const rows = db.all<{ p: string }>(sql`
        WITH RECURSIVE repo_walk(p) AS (
          SELECT (SELECT min(repo_path) FROM webhook_deliveries WHERE repo_path IS NOT NULL)
          UNION ALL
          SELECT (SELECT min(repo_path) FROM webhook_deliveries WHERE repo_path > repo_walk.p)
            FROM repo_walk WHERE repo_walk.p IS NOT NULL
        )
        SELECT p FROM repo_walk WHERE p IS NOT NULL
      `)
      return rows.map((row) => row.p)
    },
    async get(id) {
      return (
        (
          await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1)
        )[0] ?? null
      )
    },
    async terminalControl(deliveryId, actor) {
      const effect = (
        await db
          .select()
          .from(webhookMrControlEffects)
          .where(eq(webhookMrControlEffects.deliveryId, deliveryId))
          .limit(1)
      )[0]
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
        (
          await db
            .select({ id: webhookMrControlEffects.id })
            .from(webhookMrControlEffects)
            .where(eq(webhookMrControlEffects.deliveryId, deliveryId))
            .limit(1)
        )[0] !== undefined
      )
    },
  }
  return Object.freeze(queries)
}
