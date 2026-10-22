// RFC-359 W4-D9 —— PAT 调用审计的持久化：一份实现，两个 provider 共用。
//
// 有界清扫用「按 (created_at, id) 取一批 id 的子查询 + DELETE … RETURNING」一条语句完成——两个引擎语法同形，
// 不需要事务（旧 SQLite 版按 rowid 手写 SQL，旧 PG 版先 select 再 delete 两句开一笔事务，现在都是这一句）。

import { insertOne } from '@/platform/persistence/singleInsert'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { desc, eq, inArray, lt } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { TokenCallAuditPersistence } from '../application/tokenCallAudit'

const AUDIT_ORDER = (db: object) => {
  const { tokenAudit } = tablesOf(db)
  return [desc(tokenAudit.createdAt), tokenAudit.id] as const
}

export function createTokenCallAuditPersistence(db: PersistenceDb): TokenCallAuditPersistence {
  return {
    async insertAudit(record) {
      const { tokenAudit } = tablesOf(db)
      await insertOne(db, tokenAudit, record)
    },

    async insertDeleteSnapshot(record) {
      const { tokenDeleteSnapshot } = tablesOf(db)
      await insertOne(db, tokenDeleteSnapshot, record)
    },

    async markSnapshotFailed(auditId) {
      const { tokenAudit } = tablesOf(db)
      await db.update(tokenAudit).set({ snapshotFailed: true }).where(eq(tokenAudit.id, auditId))
    },

    async listForUser(userId, limit) {
      const { tokenAudit } = tablesOf(db)
      return await db
        .select()
        .from(tokenAudit)
        .where(eq(tokenAudit.userId, userId))
        .orderBy(...AUDIT_ORDER(db))
        .limit(limit)
    },

    async list(limit) {
      const { tokenAudit } = tablesOf(db)
      return await db
        .select()
        .from(tokenAudit)
        .orderBy(...AUDIT_ORDER(db))
        .limit(limit)
    },

    async pruneSlice(input) {
      if (input.phase === 'snapshots') {
        const { tokenDeleteSnapshot } = tablesOf(db)
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
      const { tokenAudit } = tablesOf(db)
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
