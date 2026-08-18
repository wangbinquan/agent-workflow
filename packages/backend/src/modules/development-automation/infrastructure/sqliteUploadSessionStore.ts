// RFC-310 PR-3 T36 —— mission 输入上传会话 store。
//
// actor-scoped 临时 artifact：TTL 内可被 launch 事务一次性原子 claim。
// bytes 在 EvidenceStore（内容寻址 blob），本表只管 ownership/生命周期。
// claim 是全有或全无：任一 ref 不满足（缺行/非 pending/他人/过期/已被别的
// mission 拿走）则零消费——「upload-already-claimed」与「不存在」在错误码上
// 区分，但都不泄露他人行内容（uploadRef 不是 bearer capability，§12.3）。

import { and, eq, lt } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { missionInputUploads } from '@/db/schema'
import { ConflictError, NotFoundError } from '@/util/errors'
import type { UploadSessionRow, UploadSessionStore } from '../application/ports/uploadSessionStore'

export type { UploadSessionRow, UploadSessionStore }

export const UPLOAD_SESSION_TTL_MS = 2 * 60 * 60 * 1000

function rowOf(r: typeof missionInputUploads.$inferSelect): UploadSessionRow {
  return {
    id: r.id,
    actorUserId: r.actorUserId,
    originalName: r.originalName,
    bytes: r.bytes,
    sha256: r.sha256,
    blobRef: r.blobRef,
    state: r.state,
    claimedByMissionId: r.claimedByMissionId,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  }
}

export function createSqliteUploadSessionStore(db: DbClient): UploadSessionStore {
  return {
    createUpload(input) {
      if (input.idempotencyKey !== null) {
        const existing = db
          .select()
          .from(missionInputUploads)
          .where(
            and(
              eq(missionInputUploads.actorUserId, input.actorUserId ?? ''),
              eq(missionInputUploads.uploadIdempotencyKey, input.idempotencyKey),
            ),
          )
          .get()
        if (existing !== undefined) return rowOf(existing)
      }
      const row = {
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
      db.insert(missionInputUploads).values(row).run()
      return rowOf(row as typeof missionInputUploads.$inferSelect)
    },
    getUpload(id) {
      const row = db.select().from(missionInputUploads).where(eq(missionInputUploads.id, id)).get()
      return row === undefined ? null : rowOf(row)
    },
    deleteUpload(id, actorUserId) {
      const row = db.select().from(missionInputUploads).where(eq(missionInputUploads.id, id)).get()
      if (row === undefined || row.actorUserId !== actorUserId || row.state !== 'pending') {
        // 他人/已 claim 的 ref 与不存在同形——不确认资源存在性。
        throw new NotFoundError('upload-not-found', 'upload not found')
      }
      db.delete(missionInputUploads).where(eq(missionInputUploads.id, id)).run()
    },
    claimUploads(input) {
      return db.transaction((tx) => {
        const rows: UploadSessionRow[] = []
        for (const ref of input.uploadRefs) {
          const row = tx
            .select()
            .from(missionInputUploads)
            .where(eq(missionInputUploads.id, ref))
            .get()
          if (row === undefined || row.actorUserId !== input.actorUserId) {
            throw new NotFoundError('upload-not-found', `upload not found: ${ref}`)
          }
          if (row.state === 'claimed') {
            if (row.claimedByMissionId === input.missionId) {
              rows.push(rowOf(row))
              continue // launch 幂等重放：同 mission 的 claim 不再消费也不报错。
            }
            throw new ConflictError('upload-already-claimed', `upload claimed elsewhere: ${ref}`)
          }
          if (row.state !== 'pending' || row.expiresAt <= input.now) {
            throw new ConflictError('upload-not-claimable', `upload expired or unusable: ${ref}`)
          }
          tx.update(missionInputUploads)
            .set({
              state: 'claimed',
              claimedByMissionId: input.missionId,
              claimedAt: input.now,
            })
            .where(eq(missionInputUploads.id, ref))
            .run()
          rows.push({
            ...rowOf(row),
            state: 'claimed',
            claimedByMissionId: input.missionId,
          })
        }
        return rows
      })
    },
    sweepExpired(now) {
      const expired = db
        .select({ id: missionInputUploads.id })
        .from(missionInputUploads)
        .where(
          and(eq(missionInputUploads.state, 'pending'), lt(missionInputUploads.expiresAt, now)),
        )
        .all()
      for (const row of expired) {
        db.delete(missionInputUploads).where(eq(missionInputUploads.id, row.id)).run()
      }
      return expired.length
    },
  }
}
