import { desc, eq, sql } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tokenAudit, tokenDeleteSnapshot } from '@/db/schema'
import type {
  TokenAuditRecord,
  TokenCallAuditPersistence,
  TokenDeleteSnapshotRecord,
} from '../application/tokenCallAudit'

const AUDIT_ORDER = [desc(tokenAudit.createdAt), tokenAudit.id] as const

export class SqliteTokenCallAuditPersistence implements TokenCallAuditPersistence {
  constructor(private readonly db: DbClient) {}

  async insertAudit(record: TokenAuditRecord): Promise<void> {
    this.db.insert(tokenAudit).values(record).run()
  }

  async insertDeleteSnapshot(record: TokenDeleteSnapshotRecord): Promise<void> {
    this.db.insert(tokenDeleteSnapshot).values(record).run()
  }

  async markSnapshotFailed(auditId: string): Promise<void> {
    this.db.update(tokenAudit).set({ snapshotFailed: true }).where(eq(tokenAudit.id, auditId)).run()
  }

  async listForUser(userId: string, limit: number): Promise<ReadonlyArray<TokenAuditRecord>> {
    return this.db
      .select()
      .from(tokenAudit)
      .where(eq(tokenAudit.userId, userId))
      .orderBy(...AUDIT_ORDER)
      .limit(limit)
      .all()
  }

  async list(limit: number): Promise<ReadonlyArray<TokenAuditRecord>> {
    return this.db
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
    if (input.phase === 'snapshots') {
      return (
        await this.db.all<{ id: string }>(sql`
          DELETE FROM token_delete_snapshot
          WHERE rowid IN (
            SELECT rowid FROM token_delete_snapshot
            WHERE created_at < ${input.cutoff}
            ORDER BY created_at, id
            LIMIT ${input.batchSize}
          )
          RETURNING id
        `)
      ).length
    }
    return (
      await this.db.all<{ id: string }>(sql`
        DELETE FROM token_audit
        WHERE rowid IN (
          SELECT rowid FROM token_audit
          WHERE created_at < ${input.cutoff}
          ORDER BY created_at, id
          LIMIT ${input.batchSize}
        )
        RETURNING id
      `)
    ).length
  }
}
