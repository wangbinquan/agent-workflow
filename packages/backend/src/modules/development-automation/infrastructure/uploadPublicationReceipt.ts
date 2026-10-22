// RFC-310 PR-5 T59 / RFC-359 W4-D12 —— 上传 seed 的 publication receipt（design §9.1 尾）：一份实现，两个 provider 共用。
//
// 首次成功 publish 后，plan 的 created/replaced entry 视为「已被 candidate 吸收」——落 receiptKind='publication' 行
// （unique(planId, baselineSnapshotRef, receiptKind) 幂等：同一 baseline 的重放不产生第二行）。此后 fresh 重建 /
// 后续 action 的 no-change 判定都以该 receipt 为准（seed 已进入发布链，不再是待交付物）。调用点在 source.push effect
// 结算 arm（主 session 接线）。查—插在一笔事务里，并发重放由唯一索引 + `onConflictDoNothing().returning()` 兜底。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'

export interface RecordUploadPublicationInput {
  readonly planId: string
  readonly baselineSnapshotRef: string
  readonly commitSha: string
  readonly seedChangeRef: string | null
  readonly seedTreeDigest: string | null
  /** 逐 entry 的最终 digest（candidate lineage 的 finalDigests 原样传入）。 */
  readonly entries: readonly { readonly targetPath: string; readonly sha256: string }[]
  readonly now: number
}

function publicationOf(db: object, planId: string, baselineSnapshotRef: string) {
  const { developmentRepositoryUploadReceipts } = tablesOf(db)
  return and(
    eq(developmentRepositoryUploadReceipts.planId, planId),
    eq(developmentRepositoryUploadReceipts.baselineSnapshotRef, baselineSnapshotRef),
    eq(developmentRepositoryUploadReceipts.receiptKind, 'publication'),
  )
}

export async function recordUploadPublicationReceipt(
  db: PersistenceDb,
  input: RecordUploadPublicationInput,
): Promise<{ readonly created: boolean; readonly receiptId: string }> {
  return await databaseSessionFor(db).transaction(async (tx) => {
    const { developmentRepositoryUploadReceipts } = tablesOf(tx)
    const existing = (
      await tx
        .select({ id: developmentRepositoryUploadReceipts.id })
        .from(developmentRepositoryUploadReceipts)
        .where(publicationOf(tx, input.planId, input.baselineSnapshotRef))
        .limit(1)
    )[0]
    if (existing !== undefined) return { created: false, receiptId: existing.id }
    const id = ulid()
    const inserted = (
      await tx
        .insert(developmentRepositoryUploadReceipts)
        .values({
          id,
          planId: input.planId,
          baselineSnapshotRef: input.baselineSnapshotRef,
          receiptKind: 'publication',
          seedChangeRef: input.seedChangeRef,
          seedTreeDigest: input.seedTreeDigest,
          fulfillmentKind: 'published',
          commitSha: input.commitSha,
          entriesJson: JSON.stringify(input.entries),
          createdAt: input.now,
        })
        .onConflictDoNothing()
        .returning({ id: developmentRepositoryUploadReceipts.id })
    )[0]
    if (inserted !== undefined) return { created: true, receiptId: inserted.id }
    const winner = (
      await tx
        .select({ id: developmentRepositoryUploadReceipts.id })
        .from(developmentRepositoryUploadReceipts)
        .where(publicationOf(tx, input.planId, input.baselineSnapshotRef))
        .limit(1)
    )[0]
    if (winner === undefined) throw new Error('upload publication receipt winner unavailable')
    return { created: false, receiptId: winner.id }
  })
}

/** 读侧：该 plan 是否已有 publication receipt（arm 幂等判定 / 事实投影用）。 */
export async function hasUploadPublicationReceipt(
  db: PersistenceDb,
  planId: string,
): Promise<boolean> {
  const { developmentRepositoryUploadReceipts } = tablesOf(db)
  const row = (
    await db
      .select({ id: developmentRepositoryUploadReceipts.id })
      .from(developmentRepositoryUploadReceipts)
      .where(
        and(
          eq(developmentRepositoryUploadReceipts.planId, planId),
          eq(developmentRepositoryUploadReceipts.receiptKind, 'publication'),
        ),
      )
      .limit(1)
  )[0]
  return row !== undefined
}
