// RFC-310 PR-3 T36 / RFC-359 W4-D11 —— mission 输入上传会话：一份实现，两个 provider 共用。
//
// actor-scoped 临时 artifact：TTL 内可被 launch 事务一次性原子 claim。bytes 在 EvidenceStore（内容寻址 blob），
// 本表只管 ownership / 生命周期。claim 是全有或全无：任一 ref 不满足（缺行 / 非 pending / 他人 / 过期 / 已被别的
// mission 拿走）则零消费——「upload-already-claimed」与「不存在」在错误码上区分，但都不泄露他人行内容
// （uploadRef 不是 bearer capability，§12.3）。
//
// `claimUploadSessions(tx, …)` 是唯一的认领原语：launch 事务（missionStore.commitMissionLaunch）在自己的事务里
// 直接调用它，`UploadSessionPersistence.claimUploads` 只是给它套一笔事务。

import { and, eq, gt, inArray, isNull, lt } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { ProviderNeutralDatabase } from '@/db/query'
import { missionInputUploads } from '@/db/schema'
import {
  databaseSessionFor,
  type DatabaseTransaction,
} from '@/platform/persistence/databaseTransaction'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  UploadSessionPersistence,
  UploadSessionRow,
} from '../application/ports/uploadSessionStore'

export type { UploadSessionPersistence, UploadSessionRow }

export const UPLOAD_SESSION_TTL_MS = 2 * 60 * 60 * 1000
export const UPLOAD_SESSION_SWEEP_LIMIT = 1_000

export function uploadSessionRowOf(row: typeof missionInputUploads.$inferSelect): UploadSessionRow {
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

function actorFence(actorUserId: string | null) {
  return actorUserId === null
    ? isNull(missionInputUploads.actorUserId)
    : eq(missionInputUploads.actorUserId, actorUserId)
}

/**
 * 全有或全无的原子 claim（调用方持有事务；任一 ref 失败抛错即整笔回滚）。每个 ref 先做一条
 * `pending ∧ 未过期 ∧ 本人` 的条件 UPDATE … RETURNING（CAS），没改到再读一行把失败分类：
 * 缺行 / 他人 → `upload-not-found`；被别的 mission 拿走 → `upload-already-claimed`；同 mission 重放 → 幂等通过；
 * 其余（过期 / 非 pending）→ `upload-not-claimable`。成功返回按输入序的行。
 */
export async function claimUploadSessions(
  tx: DatabaseTransaction,
  input: {
    readonly missionId: string
    readonly actorUserId: string | null
    readonly uploadRefs: readonly string[]
    readonly now: number
  },
): Promise<UploadSessionRow[]> {
  const rows: UploadSessionRow[] = []
  for (const uploadRef of input.uploadRefs) {
    const claimed = (
      await tx
        .update(missionInputUploads)
        .set({ state: 'claimed', claimedByMissionId: input.missionId, claimedAt: input.now })
        .where(
          and(
            eq(missionInputUploads.id, uploadRef),
            actorFence(input.actorUserId),
            eq(missionInputUploads.state, 'pending'),
            gt(missionInputUploads.expiresAt, input.now),
          ),
        )
        .returning()
    )[0]
    if (claimed !== undefined) {
      rows.push(uploadSessionRowOf(claimed))
      continue
    }
    const current = (
      await tx
        .select()
        .from(missionInputUploads)
        .where(eq(missionInputUploads.id, uploadRef))
        .limit(1)
    )[0]
    if (current === undefined || current.actorUserId !== input.actorUserId) {
      throw new NotFoundError('upload-not-found', `upload not found: ${uploadRef}`)
    }
    if (current.state === 'claimed') {
      if (current.claimedByMissionId === input.missionId) {
        rows.push(uploadSessionRowOf(current)) // launch 幂等重放：同 mission 的 claim 不再消费也不报错。
        continue
      }
      throw new ConflictError('upload-already-claimed', `upload claimed elsewhere: ${uploadRef}`)
    }
    throw new ConflictError('upload-not-claimable', `upload expired or unusable: ${uploadRef}`)
  }
  return rows
}

export function createUploadSessionPersistence(
  db: ProviderNeutralDatabase,
): UploadSessionPersistence {
  const session = databaseSessionFor(db)
  return {
    async createUpload(input) {
      // 幂等键（actor, idempotencyKey）的查—插在一笔事务里；同键并发由 insert 的冲突路径兜底。
      return await session.transaction(async (tx) => {
        const byKey =
          input.idempotencyKey === null
            ? undefined
            : and(
                actorFence(input.actorUserId),
                eq(missionInputUploads.uploadIdempotencyKey, input.idempotencyKey),
              )
        if (byKey !== undefined) {
          const existing = (await tx.select().from(missionInputUploads).where(byKey).limit(1))[0]
          if (existing !== undefined) return uploadSessionRowOf(existing)
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
        const inserted = (
          await tx.insert(missionInputUploads).values(row).onConflictDoNothing().returning()
        )[0]
        if (inserted !== undefined) return uploadSessionRowOf(inserted)
        if (byKey === undefined) {
          throw new Error(`mission input upload insert conflicted for new id ${row.id}`)
        }
        const winner = (await tx.select().from(missionInputUploads).where(byKey).limit(1))[0]
        if (winner === undefined) {
          throw new Error('mission input upload idempotency winner is unavailable')
        }
        return uploadSessionRowOf(winner)
      })
    },
    async getUpload(id) {
      const row = (
        await db.select().from(missionInputUploads).where(eq(missionInputUploads.id, id)).limit(1)
      )[0]
      return row === undefined ? null : uploadSessionRowOf(row)
    },
    async deleteUpload(id, actorUserId) {
      // 本人 + pending 的围栏写在语句里；他人 / 已 claim 的 ref 与不存在同形——不确认资源存在性。
      const deleted = await db
        .delete(missionInputUploads)
        .where(
          and(
            eq(missionInputUploads.id, id),
            actorFence(actorUserId),
            eq(missionInputUploads.state, 'pending'),
          ),
        )
        .returning({ id: missionInputUploads.id })
      if (deleted.length !== 1) throw new NotFoundError('upload-not-found', 'upload not found')
    },
    async claimUploads(input) {
      return await session.transaction((tx) => claimUploadSessions(tx, input))
    },
    async sweepExpired(now, limit = UPLOAD_SESSION_SWEEP_LIMIT) {
      // 「子查询取一批 id + DELETE … RETURNING」一条语句，两引擎同形；只清 pending。
      const batch = db
        .select({ id: missionInputUploads.id })
        .from(missionInputUploads)
        .where(
          and(eq(missionInputUploads.state, 'pending'), lt(missionInputUploads.expiresAt, now)),
        )
        .orderBy(missionInputUploads.expiresAt, missionInputUploads.id)
        .limit(limit)
      return (
        await db
          .delete(missionInputUploads)
          .where(inArray(missionInputUploads.id, batch))
          .returning({ id: missionInputUploads.id })
      ).length
    },
  }
}
