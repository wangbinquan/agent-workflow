import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'

import { employeeInputUploads } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  EmployeeInputUploadPersistence,
  EmployeeInputUploadRecord,
} from '../application/ports/inputUploadStore'
import { EMPLOYEE_INPUT_UPLOAD_SWEEP_LIMIT, EMPLOYEE_INPUT_UPLOAD_TTL_MS } from './inputUploadStore'

function recordOf(row: typeof employeeInputUploads.$inferSelect): EmployeeInputUploadRecord {
  return {
    id: row.id,
    actorUserId: row.actorUserId,
    originalName: row.originalName,
    bytes: row.bytes,
    sha256: row.sha256,
    blobRef: row.blobRef,
    state: row.state,
    claimedByCaseId: row.claimedByCaseId,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  }
}

export function createPostgresqlEmployeeInputUploadPersistence(
  db: PostgresqlDatabaseClient,
): EmployeeInputUploadPersistence {
  return {
    async create(input) {
      if (input.idempotencyKey !== null) {
        const existing = await db
          .select()
          .from(employeeInputUploads)
          .where(
            and(
              input.actorUserId === null
                ? isNull(employeeInputUploads.actorUserId)
                : eq(employeeInputUploads.actorUserId, input.actorUserId),
              eq(employeeInputUploads.uploadIdempotencyKey, input.idempotencyKey),
            ),
          )
          .get()
        if (existing !== undefined) return recordOf(existing)
      }
      const id = ulid()
      await db
        .insert(employeeInputUploads)
        .values({
          id,
          actorUserId: input.actorUserId,
          originalName: input.originalName,
          bytes: input.bytes,
          sha256: input.sha256,
          blobRef: input.blobRef,
          uploadIdempotencyKey: input.idempotencyKey,
          state: 'pending',
          claimedByCaseId: null,
          expiresAt: input.now + EMPLOYEE_INPUT_UPLOAD_TTL_MS,
          createdAt: input.now,
          claimedAt: null,
        })
        .run()
      const created = await db
        .select()
        .from(employeeInputUploads)
        .where(eq(employeeInputUploads.id, id))
        .get()
      if (created === undefined) throw new Error('employee input upload vanished after insert')
      return recordOf(created)
    },
    async resolveForCase(input) {
      const seen = new Set<string>()
      const records: EmployeeInputUploadRecord[] = []
      for (const id of input.ids) {
        if (seen.has(id)) {
          throw new ConflictError(
            'employee-upload-duplicate',
            `upload appears more than once: ${id}`,
          )
        }
        seen.add(id)
        const row = await db
          .select()
          .from(employeeInputUploads)
          .where(eq(employeeInputUploads.id, id))
          .get()
        if (row === undefined || row.actorUserId !== input.actorUserId) {
          throw new NotFoundError('employee-upload-not-found', 'upload not found')
        }
        if (row.state === 'claimed' && row.claimedByCaseId === input.caseId) {
          records.push(recordOf(row))
          continue
        }
        if (row.state !== 'pending' || row.expiresAt <= input.now) {
          throw new ConflictError(
            'employee-upload-not-claimable',
            `upload is expired or already claimed: ${id}`,
          )
        }
        records.push(recordOf(row))
      }
      return records
    },
    async delete(id, actorUserId) {
      const deleted = await db
        .delete(employeeInputUploads)
        .where(
          and(
            eq(employeeInputUploads.id, id),
            actorUserId === null
              ? isNull(employeeInputUploads.actorUserId)
              : eq(employeeInputUploads.actorUserId, actorUserId),
            eq(employeeInputUploads.state, 'pending'),
          ),
        )
        .returning({ id: employeeInputUploads.id })
        .all()
      if (deleted.length !== 1) {
        throw new NotFoundError('employee-upload-not-found', 'upload not found')
      }
    },
    async sweepExpired(now, limit = EMPLOYEE_INPUT_UPLOAD_SWEEP_LIMIT) {
      const expired = await db
        .select({ id: employeeInputUploads.id })
        .from(employeeInputUploads)
        .where(
          and(eq(employeeInputUploads.state, 'pending'), lt(employeeInputUploads.expiresAt, now)),
        )
        .limit(limit)
        .all()
      if (expired.length > 0) {
        await db
          .delete(employeeInputUploads)
          .where(
            inArray(
              employeeInputUploads.id,
              expired.map((row) => row.id),
            ),
          )
          .run()
      }
      return expired.length
    },
  }
}
