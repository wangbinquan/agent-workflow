import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { missionInputUploads } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { NotFoundError } from '@/util/errors'
import type { MissionInputUploadPersistence } from '../application/missionInputUploadOperations'
import type { UploadMaintenancePersistence } from '../application/ports/uploadMaintenance'
import type { UploadSessionRow } from '../application/ports/uploadSessionStore'
import { UPLOAD_SESSION_TTL_MS, createSqliteUploadSessionStore } from './sqliteUploadSessionStore'

function rowOf(row: typeof missionInputUploads.$inferSelect): UploadSessionRow {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    originalName: row.originalName,
    bytes: row.bytes,
    sha256: row.sha256,
    blobRef: row.blobRef,
    state: row.state,
    claimedByMissionId: row.claimedByMissionId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

export function createSqliteMissionInputUploadPersistence(
  db: DbClient,
): MissionInputUploadPersistence {
  const store = createSqliteUploadSessionStore(db)
  return {
    get: async (uploadRef) => store.getUpload(uploadRef),
    create: async (input) => store.createUpload(input),
    delete: async ({ uploadRef, actorUserId }) => store.deleteUpload(uploadRef, actorUserId),
  }
}

export function createSqliteUploadMaintenancePersistence(
  db: DbClient,
): UploadMaintenancePersistence {
  const store = createSqliteUploadSessionStore(db)
  return {
    async sweepExpired(now, limit) {
      return store.sweepExpired(now, limit)
    },
  }
}

/**
 * PostgreSQL transport persistence. Idempotency and insertion share one
 * serializable transaction; deletion is actor/state fenced in the statement.
 */
export function createPostgresqlMissionInputUploadPersistence(
  db: PostgresqlDatabaseClient,
): MissionInputUploadPersistence {
  return {
    async get(uploadRef) {
      const row = await db
        .select()
        .from(missionInputUploads)
        .where(eq(missionInputUploads.id, uploadRef))
        .limit(1)
        .get()
      return row === undefined ? null : rowOf(row)
    },
    async create(input) {
      return await db.transaction(async (tx) => {
        if (input.idempotencyKey !== null) {
          const existing = await tx
            .select()
            .from(missionInputUploads)
            .where(
              and(
                input.actorUserId === null
                  ? isNull(missionInputUploads.actorUserId)
                  : eq(missionInputUploads.actorUserId, input.actorUserId),
                eq(missionInputUploads.uploadIdempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1)
            .get()
          if (existing !== undefined) return rowOf(existing)
        }
        const row: typeof missionInputUploads.$inferInsert = {
          id: ulid(),
          actorUserId: input.actorUserId,
          originalName: input.originalName,
          bytes: input.bytes,
          sha256: input.sha256,
          blobRef: input.blobRef,
          state: 'pending',
          claimedByMissionId: null,
          uploadIdempotencyKey: input.idempotencyKey,
          expiresAt: input.now + UPLOAD_SESSION_TTL_MS,
          createdAt: input.now,
          claimedAt: null,
        }
        const inserted = await tx
          .insert(missionInputUploads)
          .values(row)
          .onConflictDoNothing()
          .returning()
          .all()
        if (inserted[0] !== undefined) return rowOf(inserted[0])
        if (input.idempotencyKey === null) {
          throw new Error(`mission input upload insert conflicted for new id ${row.id}`)
        }
        const winner = await tx
          .select()
          .from(missionInputUploads)
          .where(
            and(
              input.actorUserId === null
                ? isNull(missionInputUploads.actorUserId)
                : eq(missionInputUploads.actorUserId, input.actorUserId),
              eq(missionInputUploads.uploadIdempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1)
          .get()
        if (winner === undefined) {
          throw new Error('mission input upload idempotency winner is unavailable')
        }
        return rowOf(winner)
      })
    },
    async delete({ uploadRef, actorUserId }) {
      const deleted = await db
        .delete(missionInputUploads)
        .where(
          and(
            eq(missionInputUploads.id, uploadRef),
            actorUserId === null
              ? isNull(missionInputUploads.actorUserId)
              : eq(missionInputUploads.actorUserId, actorUserId),
            eq(missionInputUploads.state, 'pending'),
          ),
        )
        .returning({ id: missionInputUploads.id })
        .all()
      if (deleted.length !== 1) {
        throw new NotFoundError('upload-not-found', 'upload not found')
      }
    },
  }
}

export function createPostgresqlUploadMaintenancePersistence(
  db: PostgresqlDatabaseClient,
): UploadMaintenancePersistence {
  return {
    async sweepExpired(now, limit) {
      return await db.transaction(async (tx) => {
        const expired = await tx
          .select({ id: missionInputUploads.id })
          .from(missionInputUploads)
          .where(
            and(eq(missionInputUploads.state, 'pending'), lt(missionInputUploads.expiresAt, now)),
          )
          .limit(limit)
          .all()
        if (expired.length === 0) return 0
        await tx
          .delete(missionInputUploads)
          .where(
            inArray(
              missionInputUploads.id,
              expired.map((row) => row.id),
            ),
          )
          .run()
        return expired.length
      })
    },
  }
}
