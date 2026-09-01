import { desc, eq, inArray, lt } from 'drizzle-orm'

import { tokenAudit, tokenDeleteSnapshot } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  TokenAuditRecord,
  TokenCallAuditPersistence,
  TokenDeleteSnapshotRecord,
} from '../application/tokenCallAudit'

const AUDIT_ORDER = [desc(tokenAudit.createdAt), tokenAudit.id] as const

export class PostgresqlTokenCallAuditPersistence implements TokenCallAuditPersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async insertAudit(record: TokenAuditRecord): Promise<void> {
    await this.db.insert(tokenAudit).values(record).run()
  }

  async insertDeleteSnapshot(record: TokenDeleteSnapshotRecord): Promise<void> {
    await this.db.insert(tokenDeleteSnapshot).values(record).run()
  }

  async markSnapshotFailed(auditId: string): Promise<void> {
    await this.db
      .update(tokenAudit)
      .set({ snapshotFailed: true })
      .where(eq(tokenAudit.id, auditId))
      .run()
  }

  async listForUser(userId: string, limit: number): Promise<ReadonlyArray<TokenAuditRecord>> {
    return await this.db
      .select()
      .from(tokenAudit)
      .where(eq(tokenAudit.userId, userId))
      .orderBy(...AUDIT_ORDER)
      .limit(limit)
      .all()
  }

  async list(limit: number): Promise<ReadonlyArray<TokenAuditRecord>> {
    return await this.db
      .select()
      .from(tokenAudit)
      .orderBy(...AUDIT_ORDER)
      .limit(limit)
      .all()
  }

  async pruneSlice(input: {
    readonly phase: 'snapshots' | 'audits'
    readonly cutoff: number
    readonly batchSize: number
  }): Promise<number> {
    return await this.db.transaction(async (transaction) => {
      if (input.phase === 'snapshots') {
        const ids = (
          await transaction
            .select({ id: tokenDeleteSnapshot.id })
            .from(tokenDeleteSnapshot)
            .where(lt(tokenDeleteSnapshot.createdAt, input.cutoff))
            .orderBy(tokenDeleteSnapshot.createdAt, tokenDeleteSnapshot.id)
            .limit(input.batchSize)
            .all()
        ).map((row) => row.id)
        if (ids.length === 0) return 0
        return (
          await transaction
            .delete(tokenDeleteSnapshot)
            .where(inArray(tokenDeleteSnapshot.id, ids))
            .returning({ id: tokenDeleteSnapshot.id })
            .all()
        ).length
      }

      const ids = (
        await transaction
          .select({ id: tokenAudit.id })
          .from(tokenAudit)
          .where(lt(tokenAudit.createdAt, input.cutoff))
          .orderBy(tokenAudit.createdAt, tokenAudit.id)
          .limit(input.batchSize)
          .all()
      ).map((row) => row.id)
      if (ids.length === 0) return 0
      return (
        await transaction
          .delete(tokenAudit)
          .where(inArray(tokenAudit.id, ids))
          .returning({ id: tokenAudit.id })
          .all()
      ).length
    })
  }
}
