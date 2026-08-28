import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { employeeInputUploads } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'

export const EMPLOYEE_INPUT_UPLOAD_TTL_MS = 2 * 60 * 60 * 1_000
export const EMPLOYEE_INPUT_UPLOAD_SWEEP_LIMIT = 1_000

export interface EmployeeInputUploadRecord {
  readonly id: string
  readonly actorUserId: string | null
  readonly originalName: string
  readonly bytes: number
  readonly sha256: string
  readonly blobRef: string
  readonly state: 'pending' | 'claimed'
  readonly claimedByCaseId: string | null
  readonly expiresAt: number
  readonly createdAt: number
}

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

export interface EmployeeInputUploadStore {
  create(input: {
    readonly actorUserId: string | null
    readonly originalName: string
    readonly bytes: number
    readonly sha256: string
    readonly blobRef: string
    readonly idempotencyKey: string | null
    readonly now: number
  }): EmployeeInputUploadRecord
  resolveForCase(input: {
    readonly ids: readonly string[]
    readonly actorUserId: string | null
    readonly caseId: string
    readonly now: number
  }): EmployeeInputUploadRecord[]
  delete(id: string, actorUserId: string | null): void
  sweepExpired(now: number, limit?: number): number
}

export function createEmployeeInputUploadStore(db: DbClient): EmployeeInputUploadStore {
  return {
    create(input) {
      if (input.idempotencyKey !== null) {
        const existing = db
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
      const row: typeof employeeInputUploads.$inferInsert = {
        id: ulid(),
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
      }
      db.insert(employeeInputUploads).values(row).run()
      return recordOf(row as typeof employeeInputUploads.$inferSelect)
    },

    resolveForCase(input) {
      const seen = new Set<string>()
      return input.ids.map((id) => {
        if (seen.has(id)) {
          throw new ConflictError(
            'employee-upload-duplicate',
            `upload appears more than once: ${id}`,
          )
        }
        seen.add(id)
        const row = db
          .select()
          .from(employeeInputUploads)
          .where(eq(employeeInputUploads.id, id))
          .get()
        if (row === undefined || row.actorUserId !== input.actorUserId) {
          throw new NotFoundError('employee-upload-not-found', 'upload not found')
        }
        if (row.state === 'claimed' && row.claimedByCaseId === input.caseId) {
          return recordOf(row)
        }
        if (row.state !== 'pending' || row.expiresAt <= input.now) {
          throw new ConflictError(
            'employee-upload-not-claimable',
            `upload is expired or already claimed: ${id}`,
          )
        }
        return recordOf(row)
      })
    },

    delete(id, actorUserId) {
      const row = db
        .select()
        .from(employeeInputUploads)
        .where(eq(employeeInputUploads.id, id))
        .get()
      if (row === undefined || row.actorUserId !== actorUserId || row.state !== 'pending') {
        throw new NotFoundError('employee-upload-not-found', 'upload not found')
      }
      db.delete(employeeInputUploads).where(eq(employeeInputUploads.id, id)).run()
    },

    sweepExpired(now, limit = EMPLOYEE_INPUT_UPLOAD_SWEEP_LIMIT) {
      const expired = db
        .select({ id: employeeInputUploads.id })
        .from(employeeInputUploads)
        .where(
          and(eq(employeeInputUploads.state, 'pending'), lt(employeeInputUploads.expiresAt, now)),
        )
        .limit(limit)
        .all()
      if (expired.length > 0) {
        db.delete(employeeInputUploads)
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
