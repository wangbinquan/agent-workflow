// RFC-401 T4（design §10.1）—— AtomicApply 的租约参数与恢复侧的 claim 操作。
//
// 租约 60 s，apply 进行中每 20 s 续租一次；恢复只接管租约已过期（或旧版本留下、没有 claim 行）的记录。此前恢复判据是「不在
// 本进程活跃快照且 updatedAt 超过十分钟」，另一进程中超过十分钟的 staging 可能被补偿。
import type {
  AtomicApplyClaims,
  AtomicApplyJournal,
  AtomicApplyPatch,
  AtomicApplyRecoveryScene,
  AtomicApplyRow,
} from '@/platform/contracts/atomicApply'

export const ATOMIC_APPLY_LEASE_MS = 60_000
export const ATOMIC_APPLY_RENEW_EVERY_MS = 20_000

/** 两个场景的恢复适配共用的 claim 接管与 fencing 写回。 */
export function atomicApplyRecoveryClaims<Tx, Key, Insert, Row extends AtomicApplyRow>(
  journal: AtomicApplyJournal<Tx, Key, Insert, Row>,
  claims: AtomicApplyClaims<Tx>,
  options: {
    /**
     * RFC-401 T5：终态写回（补偿完成记为 failed、前滚完成记为尾部 complete）事务内的场景写，skill 场景在这里释放技能锁。
     */
    readonly settle?: (tx: Tx, row: Row) => Promise<void>
  } = {},
): Pick<AtomicApplyRecoveryScene<string, Row>, 'claim' | 'compareAndSet'> {
  return {
    claim: (row, claim) =>
      journal.transaction(async (tx) => {
        const current = await claims.find(tx, row.id)
        if (row.state === 'committed' && current?.tailState === 'complete') return 'complete'
        const taken = await claims.takeOver(
          tx,
          {
            journalId: row.id,
            token: claim.token,
            expiresAt: claim.expiresAt,
            tail: row.state === 'committed' ? 'pending' : 'none',
          },
          claim.now,
        )
        return taken ? 'taken' : 'held'
      }),
    compareAndSet: (row, patch: AtomicApplyPatch, fence) =>
      journal.transaction(async (tx) => {
        const renewed = await claims.renew(
          tx,
          {
            journalId: row.id,
            token: fence.token,
            expiresAt: fence.release === true ? fence.now : fence.now + ATOMIC_APPLY_LEASE_MS,
            ...(fence.tail === undefined ? {} : { tail: fence.tail }),
          },
          fence.now,
        )
        if (!renewed) return false
        const terminal = patch.state === 'failed' || fence.tail === 'complete'
        // 无字段的写回只是续租 / 改尾部（例如尾部完成）：journal 行不动。
        const written =
          Object.keys(patch).length === 0 ||
          (await journal.compareAndSet(tx, row.id, row.state, patch))
        if (written && terminal) await options.settle?.(tx, row)
        return written
      }),
  }
}
