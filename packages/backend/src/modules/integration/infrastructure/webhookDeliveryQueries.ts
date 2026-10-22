// RFC-359 W4-B4 —— webhook 投递审计 / 回放读模型：一份实现，两个 provider 共用。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { rawRows } from '@/platform/persistence/queryHelpers'
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm'

import { SYSTEM_USER_ID } from '@/auth/actor'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  WebhookDeliveryQueries,
  WebhookPlatformEventProvenance,
} from '../application/ports/webhookDeliveryQueries'
import { CREWSTATION_TARGET_RECEIPT_PREFIX } from './crewstation/eventContract'

/** CrewStation redelivers one event a bounded number of times; the detail shows them all. */
const PLATFORM_DELIVERY_LIMIT = 50

export function createWebhookDeliveryQueries(db: PersistenceDb): WebhookDeliveryQueries {
  /** RFC-370 v3 — a delegated delivery's receipt names its frozen CrewStation target. */
  const platformEventOf = async (
    receipt: string,
  ): Promise<WebhookPlatformEventProvenance | null> => {
    if (!receipt.startsWith(CREWSTATION_TARGET_RECEIPT_PREFIX)) return null
    const targetId = receipt.slice(CREWSTATION_TARGET_RECEIPT_PREFIX.length)
    const { csEventRoutes, csEventTargets, csEventInbox } = tablesOf(db)
    const route = (
      await db
        .select({
          id: csEventRoutes.id,
          eventId: csEventRoutes.eventId,
          envelopeJson: csEventRoutes.envelopeJson,
        })
        .from(csEventTargets)
        .innerJoin(csEventRoutes, eq(csEventRoutes.id, csEventTargets.logicalId))
        .where(eq(csEventTargets.id, targetId))
        .limit(1)
    )[0]
    if (route === undefined) return null
    const deliveries = await db
      .select({
        deliveryId: csEventInbox.deliveryId,
        attempt: csEventInbox.lastAttempt,
        receivedAt: csEventInbox.receivedAt,
      })
      .from(csEventInbox)
      .where(eq(csEventInbox.logicalId, route.id))
      .orderBy(asc(csEventInbox.receivedAt), asc(csEventInbox.deliveryId))
      .limit(PLATFORM_DELIVERY_LIMIT)
    let eventType: string | null = null
    try {
      const envelope = JSON.parse(route.envelopeJson) as { eventType?: unknown }
      if (typeof envelope.eventType === 'string') eventType = envelope.eventType
    } catch {
      eventType = null
    }
    return { eventId: route.eventId, eventType, deliveries }
  }
  const queries: WebhookDeliveryQueries = {
    async page(input) {
      const { webhookDeliveries } = tablesOf(db)
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
      const { webhookDeliveries } = tablesOf(db)
      // Loose index scan over the (repo_path, received_at) index: K distinct
      // repositories cost K index seeks instead of rescanning millions of
      // retained deliveries on every filter-options refresh. Standard SQL —
      // both engines walk the index the same way (PostgreSQL's planner has no
      // native loose scan, so a plain DISTINCT would rescan the whole table).
      const rows = await rawRows<{ p: string }>(
        db,
        sql`
        WITH RECURSIVE repo_walk(p) AS (
          SELECT (SELECT min(${webhookDeliveries.repoPath}) FROM ${webhookDeliveries} WHERE ${webhookDeliveries.repoPath} IS NOT NULL)
          UNION ALL
          SELECT (SELECT min(${webhookDeliveries.repoPath}) FROM ${webhookDeliveries} WHERE ${webhookDeliveries.repoPath} > repo_walk.p)
            FROM repo_walk WHERE repo_walk.p IS NOT NULL
        )
        SELECT p FROM repo_walk WHERE p IS NOT NULL
      `,
      )
      return rows.map((row) => row.p)
    },
    async get(id) {
      const { webhookDeliveries, csWebhookVerifications } = tablesOf(db)
      const row = (
        await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id)).limit(1)
      )[0]
      if (!row) return null
      const verification = (
        await db
          .select()
          .from(csWebhookVerifications)
          .where(eq(csWebhookVerifications.deliveryId, id))
          .limit(1)
      )[0]
      return {
        ...row,
        verificationMethod: verification ? 'cs-delegated' : 'direct-signature',
        bodyRepresentation: verification ? 'reserialized-json' : 'http-bytes',
        platformEvent:
          verification === undefined
            ? null
            : await platformEventOf(verification.transportReceiptRef),
      }
    },
    async terminalControl(deliveryId, actor) {
      const { webhookMrControlEffects, webhookMrControlTargets, tasks, taskCollaborators } =
        tablesOf(db)
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
      const { webhookMrControlEffects } = tablesOf(db)
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
