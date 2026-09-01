import { OwnerIdentitySchema, type UserPublic } from '@agent-workflow/shared'
import { and, asc, count, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'

import { resourceGrants, scheduledTasks, users } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  IntegrationTriggerAuthorityPair,
  ScheduledTaskPersistencePort,
  ScheduledTaskRecord,
} from '../application/ports/scheduledTaskPersistence'
import type {
  FrozenIntegrationTriggerResourceSnapshot,
  IntegrationTriggerResourceRequest,
} from '@/modules/resource-catalog/public/types'

export type PostgresqlScheduledTaskTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

/** Provider-private bridge: the resource snapshot joins the schedule write tx. */
export interface PostgresqlIntegrationTriggerTransactionLoader {
  loadAuthorized(
    tx: PostgresqlScheduledTaskTransaction,
    pair: IntegrationTriggerAuthorityPair,
    requests: readonly IntegrationTriggerResourceRequest[],
  ): Promise<readonly FrozenIntegrationTriggerResourceSnapshot[]>
}

const OWNER_BATCH_SIZE = 200

function toPublicUser(row: typeof users.$inferSelect): UserPublic {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
  }
}

export function createPostgresqlScheduledTaskPersistence(
  db: PostgresqlDatabaseClient,
  resources: PostgresqlIntegrationTriggerTransactionLoader,
): ScheduledTaskPersistencePort {
  const get = async (id: string): Promise<ScheduledTaskRecord | null> =>
    (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).get()) ?? null

  const persistence: ScheduledTaskPersistencePort = {
    async list() {
      return await db.select().from(scheduledTasks)
    },
    async countVisible(actor) {
      const rows = await db
        .select({ value: count() })
        .from(scheduledTasks)
        .where(
          actor.permissions.has('tasks:read:all') || actor.permissions.has('resource-acl:bypass')
            ? undefined
            : or(
                eq(scheduledTasks.ownerUserId, actor.user.id),
                inArray(
                  scheduledTasks.id,
                  db
                    .select({ resourceId: resourceGrants.resourceId })
                    .from(resourceGrants)
                    .where(
                      and(
                        eq(resourceGrants.resourceType, 'scheduled_task'),
                        eq(resourceGrants.userId, actor.user.id),
                      ),
                    ),
                ),
              ),
        )
      return rows[0]?.value ?? 0
    },
    get,
    async loadGrantLevel(resourceId, userId) {
      return (
        (
          await db
            .select({ level: resourceGrants.level })
            .from(resourceGrants)
            .where(
              and(
                eq(resourceGrants.resourceType, 'scheduled_task'),
                eq(resourceGrants.resourceId, resourceId),
                eq(resourceGrants.userId, userId),
              ),
            )
            .get()
        )?.level ?? null
      )
    },
    async listGrantedResourceIds(userId) {
      const rows = await db
        .select({ resourceId: resourceGrants.resourceId })
        .from(resourceGrants)
        .where(
          and(eq(resourceGrants.resourceType, 'scheduled_task'), eq(resourceGrants.userId, userId)),
        )
      return new Set(rows.map((row) => row.resourceId))
    },
    async loadOwnerIdentities(userIds) {
      const wanted = [...new Set(userIds)]
      const byId = new Map()
      for (let offset = 0; offset < wanted.length; offset += OWNER_BATCH_SIZE) {
        const batch = wanted.slice(offset, offset + OWNER_BATCH_SIZE)
        if (batch.length === 0) continue
        const rows = await db
          .select({ id: users.id, username: users.username, displayName: users.displayName })
          .from(users)
          .where(inArray(users.id, batch))
        for (const row of rows) {
          const parsed = OwnerIdentitySchema.safeParse(row)
          if (parsed.success) byId.set(parsed.data.id, parsed.data)
        }
      }
      return byId
    },
    async createAtomically(input) {
      await db.transaction(async (tx) => {
        const snapshots = await resources.loadAuthorized(tx, input.authority, [input.request])
        const snapshot = snapshots[0]
        if (snapshot === undefined) throw new Error('integration-trigger-snapshot-missing')
        await tx.insert(scheduledTasks).values(input.finish(snapshot))
      })
      const created = await get(input.record.id)
      if (created === null) throw new Error('scheduled task disappeared right after insert')
      return created
    },
    async updateAtomically(input) {
      await db.transaction(async (tx) => {
        const fresh = await tx
          .select()
          .from(scheduledTasks)
          .where(eq(scheduledTasks.id, input.id))
          .get()
        if (fresh === undefined) {
          throw new NotFoundError(
            'scheduled-task-not-found',
            `scheduled task '${input.id}' not found`,
          )
        }
        const decision = input.decide(fresh)
        const snapshot =
          decision.request === null
            ? null
            : (await resources.loadAuthorized(tx, input.authority, [decision.request]))[0]
        if (decision.request !== null && snapshot === undefined) {
          throw new Error('integration-trigger-snapshot-missing')
        }
        await tx
          .update(scheduledTasks)
          .set(decision.finish(snapshot ?? null))
          .where(eq(scheduledTasks.id, input.id))
      })
      const updated = await get(input.id)
      if (updated === null) throw new Error('scheduled task disappeared right after update')
      return updated
    },
    async delete(id) {
      const existing = await get(id)
      if (existing === null) return null
      await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id))
      return existing
    },
    async loadAcl(resourceId) {
      const row = await get(resourceId)
      if (row === null) return null
      const grants = await db
        .select({ userId: resourceGrants.userId, level: resourceGrants.level })
        .from(resourceGrants)
        .where(
          and(
            eq(resourceGrants.resourceType, 'scheduled_task'),
            eq(resourceGrants.resourceId, resourceId),
          ),
        )
      const wanted = [...new Set([row.ownerUserId, ...grants.map((grant) => grant.userId)])]
      const userRows =
        wanted.length === 0 ? [] : await db.select().from(users).where(inArray(users.id, wanted))
      return {
        aclRevision: row.aclRevision,
        grants,
        users: userRows.map(toPublicUser),
      }
    },
    async replaceAclAtomically(input) {
      await db.transaction(async (tx) => {
        const current = await tx
          .select({
            aclRevision: scheduledTasks.aclRevision,
            ownerUserId: scheduledTasks.ownerUserId,
          })
          .from(scheduledTasks)
          .where(eq(scheduledTasks.id, input.resourceId))
          .get()
        if (current === undefined) {
          throw new NotFoundError(
            'scheduled-task-not-found',
            `scheduled task '${input.resourceId}' not found`,
          )
        }
        if (input.expectedResourceId !== input.resourceId) {
          throw new ConflictError('acl-resource-mismatch', 'resource id changed; reload')
        }
        if (current.aclRevision !== input.expectedAclRevision) {
          throw new ConflictError(
            'acl-revision-conflict',
            `acl revision is ${current.aclRevision}, expected ${input.expectedAclRevision}; reload and retry`,
          )
        }
        if (!input.bypassOwner && current.ownerUserId !== input.actorUserId) {
          throw new ForbiddenError(
            'resource-govern-owner-only',
            'granting a scheduled task is reserved for its owner',
          )
        }
        const referenced = [...new Set(input.grants.map((grant) => grant.userId))]
        if (referenced.length > 0) {
          const rows = await tx
            .select({ id: users.id, status: users.status })
            .from(users)
            .where(inArray(users.id, referenced))
          const active = new Set(rows.filter((row) => row.status === 'active').map((row) => row.id))
          const invalid = referenced.filter((id) => id === input.systemUserId || !active.has(id))
          if (invalid.length > 0) {
            throw new ValidationError('acl-user-invalid', 'referenced user(s) not active', {
              userIds: invalid,
            })
          }
        }
        const next = new Map(input.grants.map((grant) => [grant.userId, grant.level] as const))
        next.delete(current.ownerUserId)
        await tx
          .delete(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, 'scheduled_task'),
              eq(resourceGrants.resourceId, input.resourceId),
            ),
          )
        if (next.size > 0) {
          await tx.insert(resourceGrants).values(
            [...next].map(([userId, level]) => ({
              resourceType: 'scheduled_task' as const,
              resourceId: input.resourceId,
              userId,
              level,
              addedBy: input.actorUserId,
              addedAt: input.updatedAt,
            })),
          )
        }
        await tx
          .update(scheduledTasks)
          .set({ aclRevision: current.aclRevision + 1, updatedAt: input.updatedAt })
          .where(eq(scheduledTasks.id, input.resourceId))
      })
    },
    async pollAndClaim(input) {
      if (input.limit <= 0) return []
      const due = await db
        .select()
        .from(scheduledTasks)
        .where(
          and(
            eq(scheduledTasks.enabled, true),
            isNotNull(scheduledTasks.nextRunAt),
            lte(scheduledTasks.nextRunAt, input.now),
          ),
        )
        .orderBy(asc(scheduledTasks.nextRunAt))
        .limit(input.limit)
      const claimed: ScheduledTaskRecord[] = []
      for (const row of due) {
        if (row.nextRunAt === null) continue
        const decision = input.decide(row)
        if (decision.kind === 'disable') {
          await db
            .update(scheduledTasks)
            .set({
              enabled: false,
              lastStatus: 'failed',
              lastError: decision.error,
              updatedAt: input.now,
            })
            .where(
              and(
                eq(scheduledTasks.id, row.id),
                eq(scheduledTasks.nextRunAt, row.nextRunAt),
                eq(scheduledTasks.enabled, true),
              ),
            )
          continue
        }
        const result = await db
          .update(scheduledTasks)
          .set({ nextRunAt: decision.nextRunAt, updatedAt: input.now })
          .where(
            and(
              eq(scheduledTasks.id, row.id),
              eq(scheduledTasks.nextRunAt, row.nextRunAt),
              eq(scheduledTasks.enabled, true),
            ),
          )
          .returning({ id: scheduledTasks.id })
        if (result.length > 0) claimed.push(row)
      }
      return claimed
    },
    async recordSuccess(input) {
      await db.transaction(async (tx) => {
        await tx
          .update(scheduledTasks)
          .set({ consecutiveFailures: 0, updatedAt: input.recordedAt })
          .where(eq(scheduledTasks.id, input.id))
        await tx
          .update(scheduledTasks)
          .set({
            lastStatus: 'launched',
            lastError: null,
            lastTaskId: input.taskId,
            lastRunAt: input.firedAt,
            updatedAt: input.recordedAt,
          })
          .where(
            and(
              eq(scheduledTasks.id, input.id),
              sql`(${scheduledTasks.lastRunAt} IS NULL OR ${scheduledTasks.lastRunAt} <= ${input.firedAt})`,
            ),
          )
      })
    },
    async recordFailure(input) {
      return await db.transaction(async (tx) => {
        const result = await tx
          .update(scheduledTasks)
          .set({
            consecutiveFailures: sql`${scheduledTasks.consecutiveFailures} + 1`,
            enabled: sql`CASE WHEN ${scheduledTasks.consecutiveFailures} + 1 >= ${input.maxFailures} THEN 0 ELSE ${scheduledTasks.enabled} END`,
            updatedAt: input.recordedAt,
          })
          .where(and(eq(scheduledTasks.id, input.id), eq(scheduledTasks.enabled, true)))
          .returning({ enabled: scheduledTasks.enabled })
        await tx
          .update(scheduledTasks)
          .set({
            lastStatus: 'failed',
            lastError: input.message,
            lastRunAt: input.firedAt,
            updatedAt: input.recordedAt,
          })
          .where(
            and(
              eq(scheduledTasks.id, input.id),
              sql`(${scheduledTasks.lastRunAt} IS NULL OR ${scheduledTasks.lastRunAt} <= ${input.firedAt})`,
            ),
          )
        return { autoDisabled: result[0]?.enabled === false }
      })
    },
    async updateHealedPayload(input) {
      const patch: Partial<typeof scheduledTasks.$inferInsert> = { updatedAt: input.updatedAt }
      if (input.launchPayload !== undefined) patch.launchPayload = input.launchPayload
      if (input.disableError !== undefined) {
        patch.enabled = false
        patch.nextRunAt = null
        patch.lastError = input.disableError
      }
      await db.update(scheduledTasks).set(patch).where(eq(scheduledTasks.id, input.id))
    },
  }
  return Object.freeze(persistence)
}
