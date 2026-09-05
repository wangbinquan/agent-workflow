// RFC-359 W4-D9 —— PAT 调用审计的持久化：一份实现，两个 provider 共用。
//
// 有界清扫用「按 (created_at, id) 取一批 id 的子查询 + DELETE … RETURNING」一条语句完成——两个引擎语法同形，
// 不需要事务（旧 SQLite 版按 rowid 手写 SQL，旧 PG 版先 select 再 delete 两句开一笔事务，现在都是这一句）。

import { desc, eq, inArray, lt } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { tokenAudit, tokenDeleteSnapshot } from '@/db/schema'
import type { TokenCallAuditPersistence } from '../application/tokenCallAudit'

const AUDIT_ORDER = [desc(tokenAudit.createdAt), tokenAudit.id] as const

export function createTokenCallAuditPersistence(
  db: ProviderNeutralDatabase,
): TokenCallAuditPersistence {
  return {
    async insertAudit(record) {
      await db.insert(tokenAudit).values(record)
    },

    async insertDeleteSnapshot(record) {
      await db.insert(tokenDeleteSnapshot).values(record)
    },

    async markSnapshotFailed(auditId) {
      await db.update(tokenAudit).set({ snapshotFailed: true }).where(eq(tokenAudit.id, auditId))
    },

    async listForUser(userId, limit) {
      return await db
        .select()
        .from(tokenAudit)
        .where(eq(tokenAudit.userId, userId))
        .orderBy(...AUDIT_ORDER)
        .limit(limit)
    },

    async list(limit) {
      return await db
        .select()
        .from(tokenAudit)
        .orderBy(...AUDIT_ORDER)
        .limit(limit)
    },

    async pruneSlice(input) {
      if (input.phase === 'snapshots') {
        const batch = db
          .select({ id: tokenDeleteSnapshot.id })
          .from(tokenDeleteSnapshot)
          .where(lt(tokenDeleteSnapshot.createdAt, input.cutoff))
          .orderBy(tokenDeleteSnapshot.createdAt, tokenDeleteSnapshot.id)
          .limit(input.batchSize)
        return (
          await db
            .delete(tokenDeleteSnapshot)
            .where(inArray(tokenDeleteSnapshot.id, batch))
            .returning({ id: tokenDeleteSnapshot.id })
        ).length
      }
      const batch = db
        .select({ id: tokenAudit.id })
        .from(tokenAudit)
        .where(lt(tokenAudit.createdAt, input.cutoff))
        .orderBy(tokenAudit.createdAt, tokenAudit.id)
        .limit(input.batchSize)
      return (
        await db
          .delete(tokenAudit)
          .where(inArray(tokenAudit.id, batch))
          .returning({ id: tokenAudit.id })
      ).length
    },
  }
}
