import { OwnerIdentitySchema, type UserPublic } from '@agent-workflow/shared'
import { and, asc, count, eq, inArray, isNotNull, lte, or, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { resourceGrants, scheduledTasks, users } from '@/db/schema'
import { dbTxSync, type DbTxSync } from '@/db/txSync'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import type {
  IntegrationTriggerAuthorityPair,
  ScheduledTaskPersistencePort,
  ScheduledTaskRecord,
} from '../application/ports/scheduledTaskPersistence'
import type { IntegrationTriggerResourceSnapshotInTx } from '@/modules/resource-catalog/public/participants'

export interface SqliteIntegrationTriggerTransactionBinding {
  inTransaction(
    tx: DbTxSync,
    pair: IntegrationTriggerAuthorityPair,
  ): IntegrationTriggerResourceSnapshotInTx
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

export function createSqliteScheduledTaskPersistence(
  db: DbClient,
  resources: SqliteIntegrationTriggerTransactionBinding,
): ScheduledTaskPersistencePort {
  const get = async (id: string): Promise<ScheduledTaskRecord | null> =>
    (await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1))[0] ?? null

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
            .limit(1)
        )[0]?.level ?? null
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
      dbTxSync(db, (tx) => {
        const snapshots = resources
          .inTransaction(tx, input.authority)
          .loadAuthorized(input.authority.authority, [input.request])
        const snapshot = snapshots[0]
        if (snapshot === undefined) throw new Error('integration-trigger-snapshot-missing')
        tx.insert(scheduledTasks).values(input.finish(snapshot)).run()
      })
      const created = await get(input.record.id)
      if (created === null) throw new Error('scheduled task disappeared right after insert')
      return created
    },
    async updateAtomically(input) {
      dbTxSync(db, (tx) => {
        const fresh = tx.select().from(scheduledTasks).where(eq(scheduledTasks.id, input.id)).get()
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
            : resources
                .inTransaction(tx, input.authority)
                .loadAuthorized(input.authority.authority, [decision.request])[0]
        if (decision.request !== null && snapshot === undefined) {
          throw new Error('integration-trigger-snapshot-missing')
        }
        tx.update(scheduledTasks)
          .set(decision.finish(snapshot ?? null))
          .where(eq(scheduledTasks.id, input.id))
          .run()
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
      dbTxSync(db, (tx) => {
        const current = tx
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
          const rows = tx
            .select({ id: users.id, status: users.status })
            .from(users)
            .where(inArray(users.id, referenced))
            .all()
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
        tx.delete(resourceGrants)
          .where(
            and(
              eq(resourceGrants.resourceType, 'scheduled_task'),
              eq(resourceGrants.resourceId, input.resourceId),
            ),
          )
          .run()
        if (next.size > 0) {
          tx.insert(resourceGrants)
            .values(
              [...next].map(([userId, level]) => ({
                resourceType: 'scheduled_task' as const,
                resourceId: input.resourceId,
                userId,
                level,
                addedBy: input.actorUserId,
                addedAt: input.updatedAt,
              })),
            )
            .run()
        }
        tx.update(scheduledTasks)
          .set({ aclRevision: current.aclRevision + 1, updatedAt: input.updatedAt })
          .where(eq(scheduledTasks.id, input.resourceId))
          .run()
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
        const expectedNextRunAt = row.nextRunAt
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
        const didClaim = dbTxSync(
          db,
          (tx) =>
            tx
              .update(scheduledTasks)
              .set({ nextRunAt: decision.nextRunAt, updatedAt: input.now })
              .where(
                and(
                  eq(scheduledTasks.id, row.id),
                  eq(scheduledTasks.nextRunAt, expectedNextRunAt),
                  eq(scheduledTasks.enabled, true),
                ),
              )
              .returning({ id: scheduledTasks.id })
              .get() !== undefined,
        )
        if (didClaim) claimed.push(row)
      }
      return claimed
    },
    async recordSuccess(input) {
      dbTxSync(db, (tx) => {
        tx.update(scheduledTasks)
          .set({ consecutiveFailures: 0, updatedAt: input.recordedAt })
          .where(eq(scheduledTasks.id, input.id))
          .run()
        tx.update(scheduledTasks)
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
          .run()
      })
    },
    async recordFailure(input) {
      return dbTxSync(db, (tx) => {
        const result = tx
          .update(scheduledTasks)
          .set({
            consecutiveFailures: sql`${scheduledTasks.consecutiveFailures} + 1`,
            // `THEN false`，不是 `THEN 0`：`enabled` 在 PostgreSQL 投影里是 boolean，混进
            // 整数会让整条 CASE 以 `CASE types boolean and integer cannot be matched`
            // （42804）失败，连锁失败次数也就永远攒不到自动停用。SQLite 认 false 为 0，
            // 两侧因此可以保持同一份写法。见 rfc349-boolean-expression-parity.test.ts。
            enabled: sql`CASE WHEN ${scheduledTasks.consecutiveFailures} + 1 >= ${input.maxFailures} THEN false ELSE ${scheduledTasks.enabled} END`,
            updatedAt: input.recordedAt,
          })
          .where(and(eq(scheduledTasks.id, input.id), eq(scheduledTasks.enabled, true)))
          .returning({ enabled: scheduledTasks.enabled })
          .get()
        tx.update(scheduledTasks)
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
          .run()
        return { autoDisabled: result?.enabled === false }
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
