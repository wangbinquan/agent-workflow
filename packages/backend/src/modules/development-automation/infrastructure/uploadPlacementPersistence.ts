// RFC-359 W4-D12 —— 上传 placement 的读写：一份实现，两个 provider 共用。
// record 的幂等落在 `dev_upload_receipts_unique`（plan, baseline, receiptKind）上：`onConflictDoNothing` 两引擎同形。

import { asc, eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import {
  developmentRepositoryUploadPlanEntries,
  developmentRepositoryUploadPlans,
  developmentRepositoryUploadReceipts,
} from '@/db/schema'
import type { UploadPlacementPersistence } from '../application/ports/uploadPlacementStore'

export function createUploadPlacementPersistence(
  db: ProviderNeutralDatabase,
): UploadPlacementPersistence {
  return {
    async load(planId) {
      const plan = (
        await db
          .select()
          .from(developmentRepositoryUploadPlans)
          .where(eq(developmentRepositoryUploadPlans.id, planId))
          .limit(1)
      )[0]
      if (plan === undefined) return null
      const entries = await db
        .select()
        .from(developmentRepositoryUploadPlanEntries)
        .where(eq(developmentRepositoryUploadPlanEntries.planId, planId))
        .orderBy(asc(developmentRepositoryUploadPlanEntries.ordinal))
      const receipts = await db
        .select({
          receiptKind: developmentRepositoryUploadReceipts.receiptKind,
          seedTreeDigest: developmentRepositoryUploadReceipts.seedTreeDigest,
        })
        .from(developmentRepositoryUploadReceipts)
        .where(eq(developmentRepositoryUploadReceipts.planId, planId))
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
    },
  }
}
