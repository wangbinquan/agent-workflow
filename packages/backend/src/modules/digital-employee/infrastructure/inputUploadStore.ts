// RFC-359 W4-D7a —— 数字员工临时输入上传（employee_input_uploads）：一份实现，两个 provider 共用。
//
// 语义沿 RFC-310 的 SQLite store：幂等键命中即返回既有行；resolveForCase 逐个 id 校验归属 / 状态 / 过期；
// delete 只删本人的 pending 行（单语句 returning 判 404）；sweepExpired 每片只删一个有界批次。

import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { employeeInputUploads } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  EmployeeInputUploadPersistence,
  EmployeeInputUploadRecord,
} from '../application/ports/inputUploadStore'

export const EMPLOYEE_INPUT_UPLOAD_TTL_MS = 2 * 60 * 60 * 1_000
export const EMPLOYEE_INPUT_UPLOAD_SWEEP_LIMIT = 1_000

export type { EmployeeInputUploadRecord } from '../application/ports/inputUploadStore'

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

function actorWhere(actorUserId: string | null) {
  return actorUserId === null
    ? isNull(employeeInputUploads.actorUserId)
    : eq(employeeInputUploads.actorUserId, actorUserId)
}

export function createEmployeeInputUploadPersistence(
  db: ProviderNeutralDatabase,
): EmployeeInputUploadPersistence {
  return {
    async create(input) {
      if (input.idempotencyKey !== null) {
        const existing = (
          await db
            .select()
            .from(employeeInputUploads)
            .where(
              and(
                actorWhere(input.actorUserId),
                eq(employeeInputUploads.uploadIdempotencyKey, input.idempotencyKey),
              ),
            )
            .limit(1)
        )[0]
        if (existing !== undefined) return recordOf(existing)
      }
      const row = {
        id: ulid(),
        actorUserId: input.actorUserId,
        originalName: input.originalName,
        bytes: input.bytes,
        sha256: input.sha256,
        blobRef: input.blobRef,
        uploadIdempotencyKey: input.idempotencyKey,
        state: 'pending' as const,
        claimedByCaseId: null,
        expiresAt: input.now + EMPLOYEE_INPUT_UPLOAD_TTL_MS,
        createdAt: input.now,
        claimedAt: null,
      }
      await db.insert(employeeInputUploads).values(row)
      return recordOf(row)
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
        const row = (
          await db
            .select()
            .from(employeeInputUploads)
            .where(eq(employeeInputUploads.id, id))
            .limit(1)
        )[0]
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
            actorWhere(actorUserId),
            eq(employeeInputUploads.state, 'pending'),
          ),
        )
        .returning({ id: employeeInputUploads.id })
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
      if (expired.length > 0) {
        await db.delete(employeeInputUploads).where(
          inArray(
            employeeInputUploads.id,
            expired.map((row) => row.id),
          ),
        )
      }
      return expired.length
    },
  }
}
