// RFC-401 T4 —— `atomic_apply_claims` 的唯一读写（表归 platform/atomic-apply 所有）。全部 SQL 在调用方传入的事务上执行。
import { and, eq, lte, sql } from 'drizzle-orm'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { AtomicApplyClaimRow, AtomicApplyClaims } from '@/platform/contracts/atomicApply'

/** 一个场景（`intent` / `resource-package`）的 claim 读写。 */
export function createAtomicApplyClaimStore(scene: string): AtomicApplyClaims<PersistenceTx> {
  return Object.freeze<AtomicApplyClaims<PersistenceTx>>({
    async insert(tx, claim, now) {
      const { atomicApplyClaims } = tablesOf(tx)
      await tx.insert(atomicApplyClaims).values({
        scene,
        journalId: claim.journalId,
        claimedBy: claim.token,
        leaseEpoch: 1,
        claimExpiresAt: claim.expiresAt,
        tailState: 'none',
        createdAt: now,
        updatedAt: now,
      })
    },
    async renew(tx, fence, now) {
      const { atomicApplyClaims } = tablesOf(tx)
      const renewed = await tx
        .update(atomicApplyClaims)
        .set({
          claimExpiresAt: fence.expiresAt,
          ...(fence.tail === undefined ? {} : { tailState: fence.tail }),
          updatedAt: now,
        })
        .where(
          and(
            eq(atomicApplyClaims.scene, scene),
            eq(atomicApplyClaims.journalId, fence.journalId),
            eq(atomicApplyClaims.claimedBy, fence.token),
          ),
        )
        .returning({ journalId: atomicApplyClaims.journalId })
      return renewed.length === 1
    },
    async takeOver(tx, claim, now) {
      const { atomicApplyClaims } = tablesOf(tx)
      // 旧版本留下的 journal 没有 claim 行：视为已过期，直接以新令牌接管。并发接管时输家落到下面的条件更新，
      // 而赢家刚写下的租约尚未过期，于是输家得到 0 行（held）。
      const inserted = await tx
        .insert(atomicApplyClaims)
        .values({
          scene,
          journalId: claim.journalId,
          claimedBy: claim.token,
          leaseEpoch: 1,
          claimExpiresAt: claim.expiresAt,
          tailState: claim.tail,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ journalId: atomicApplyClaims.journalId })
      if (inserted.length === 1) return true
      const taken = await tx
        .update(atomicApplyClaims)
        .set({
          claimedBy: claim.token,
          leaseEpoch: sql`${atomicApplyClaims.leaseEpoch} + 1`,
          claimExpiresAt: claim.expiresAt,
          tailState: claim.tail,
          updatedAt: now,
        })
        .where(
          and(
            eq(atomicApplyClaims.scene, scene),
            eq(atomicApplyClaims.journalId, claim.journalId),
            lte(atomicApplyClaims.claimExpiresAt, now),
          ),
        )
        .returning({ journalId: atomicApplyClaims.journalId })
      return taken.length === 1
    },
    async find(tx, journalId) {
      const { atomicApplyClaims } = tablesOf(tx)
      const row = (
        await tx
          .select()
          .from(atomicApplyClaims)
          .where(
            and(eq(atomicApplyClaims.scene, scene), eq(atomicApplyClaims.journalId, journalId)),
          )
          .limit(1)
      )[0]
      if (row === undefined) return undefined
      return Object.freeze<AtomicApplyClaimRow>({
        scene: row.scene,
        journalId: row.journalId,
        claimedBy: row.claimedBy,
        leaseEpoch: row.leaseEpoch,
        claimExpiresAt: row.claimExpiresAt,
        tailState: row.tailState,
      })
    },
  })
}
