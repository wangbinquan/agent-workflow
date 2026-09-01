import { asc, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
  developmentRepositoryUploadReceipts,
} from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { UploadPlacementPersistence } from '../application/ports/uploadPlacementStore'

export function createSqliteUploadPlacementPersistence(db: DbClient): UploadPlacementPersistence {
  return {
    async load(planId) {
      const plan = db
        .select()
        .from(developmentRepositoryUploadPlans)
        .where(eq(developmentRepositoryUploadPlans.id, planId))
        .get()
      if (plan === undefined) return null
      const entries = db
        .select()
        .from(developmentRepositoryUploadPlanEntries)
        .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
        .orderBy(asc(developmentRepositoryUploadPlanEntries.ordinal))
        .all()
      const placement = db
        .select({
          receiptKind: developmentRepositoryUploadReceipts.receiptKind,
          seedTreeDigest: developmentRepositoryUploadReceipts.seedTreeDigest,
        })
        .from(developmentRepositoryUploadReceipts)
        .where(eq(developmentRepositoryUploadReceipts.planId, planId))
        .all()
        .find((row) => row.receiptKind === 'placement')
      return {
        planId,
        planDigest: plan.planDigest,
        baselineSnapshotRef: plan.baselineSnapshotRef,
        baselineSha: plan.baselineSha,
        entries,
        placementReceipt:
          placement === undefined ? null : { seedTreeDigest: placement.seedTreeDigest },
      }
    },
    async record(input) {
      const existing = db
        .select({ id: developmentRepositoryUploadReceipts.id })
        .from(developmentRepositoryUploadReceipts)
        .where(eq(developmentRepositoryUploadReceipts.planId, input.planId))
        .all()
      if (existing.length > 0) return
      db.insert(developmentRepositoryUploadReceipts)
        .values({ ...input, receiptKind: 'placement' })
        .run()
    },
  }
}

export function createPostgresqlUploadPlacementPersistence(
  db: PostgresqlDatabaseClient,
): UploadPlacementPersistence {
  return {
    async load(planId) {
      const plan = await db
        .select()
        .from(developmentRepositoryUploadPlans)
        .where(eq(developmentRepositoryUploadPlans.id, planId))
        .limit(1)
        .get()
      if (plan === undefined) return null
      const entries = await db
        .select()
        .from(developmentRepositoryUploadPlanEntries)
        .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
        .orderBy(asc(developmentRepositoryUploadPlanEntries.ordinal))
        .all()
      const receipts = await db
        .select({
          receiptKind: developmentRepositoryUploadReceipts.receiptKind,
          seedTreeDigest: developmentRepositoryUploadReceipts.seedTreeDigest,
        })
        .from(developmentRepositoryUploadReceipts)
        .where(eq(developmentRepositoryUploadReceipts.planId, planId))
        .all()
      const placement = receipts.find((row) => row.receiptKind === 'placement')
      return {
        planId,
        planDigest: plan.planDigest,
        baselineSnapshotRef: plan.baselineSnapshotRef,
        baselineSha: plan.baselineSha,
        entries,
        placementReceipt:
          placement === undefined ? null : { seedTreeDigest: placement.seedTreeDigest },
      }
    },
    async record(input) {
      await db
        .insert(developmentRepositoryUploadReceipts)
        .values({ ...input, receiptKind: 'placement' })
        .onConflictDoNothing()
        .run()
    },
  }
}
