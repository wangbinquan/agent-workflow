// RFC-369 —— node_run「旧代被取代」的唯一判据（纯函数）。
//
// 与 RFC-144 的「铸行即取代」闭包逐字对应（原先写在 `infrastructure/nodeRunMintParticipant.ts` 的
// 铸造事务里），只是把「以新行为参照、在铸造那一刻执行」改成「以旧行为参照、在读到时判定」——
// 铸造事务里那次同帧范围读在 PostgreSQL SERIALIZABLE 下按索引页互判读写依赖，同一任务的并发铸造因此
// 互相中止（design §1）。等价的 SQL 谓词在 `infrastructure/nodeRunSupersession.ts`，两者由对拍测试锁住。
//
// 行 R **被结构性取代**，当且仅当：
//   (a) R 是顶层行，且同帧（同 task / node / iteration / container）存在 id 更大的行 S，
//       S 不带 shard 或与 R 同 shard——今天铸造按**新行**的 shard 收口：新行带 shard 只取代同 shard
//       的前代，不带 shard 取代全部前代。**不约束 S 是否顶层**（今天铸造只约束旧行）。
//   (b) R 是**直接**子行，且它的父行按 (a) 被取代——只看父行的结构，与父行自身的 merge_state 无关
//       （扇出 wrapper 父行常为 NULL / merged）；只下探一层，孙行不在内。
//
// 结构性被取代的行，只在 merge_state 处于 `SUPERSEDABLE_MERGE_STATES` 时才被围栏 / 重放排除所作用。

import type { MergeStateOrNull } from '@agent-workflow/shared'

export interface SupersessionRow {
  readonly id: string
  readonly nodeId: string
  readonly iteration: number
  readonly containerRunId: string | null
  readonly parentNodeRunId: string | null
  readonly shardKey: string | null
}

/** 今天铸造 UPDATE 的 `inArray(mergeState, ABANDONABLE)`；去掉了不属于 `MERGE_STATES` 的死值。 */
export const SUPERSEDABLE_MERGE_STATES = ['isolating', 'pending-merge', 'conflict-human'] as const

export function isSupersedableMergeState(state: MergeStateOrNull): boolean {
  return state !== null && (SUPERSEDABLE_MERGE_STATES as readonly string[]).includes(state)
}

function supersededTopLevel(row: SupersessionRow, rows: readonly SupersessionRow[]): boolean {
  if (row.parentNodeRunId !== null) return false
  return rows.some(
    (newer) =>
      newer.nodeId === row.nodeId &&
      newer.iteration === row.iteration &&
      newer.containerRunId === row.containerRunId &&
      newer.id > row.id &&
      (newer.shardKey === null || newer.shardKey === row.shardKey),
  )
}

/** `rows` 必须是同一任务的**全部** node_runs（不能只传顶层行：(a) 不约束 S 是否顶层）。 */
export function isStructurallySuperseded(
  row: SupersessionRow,
  rows: readonly SupersessionRow[],
): boolean {
  if (row.parentNodeRunId === null) return supersededTopLevel(row, rows)
  const parent = rows.find((candidate) => candidate.id === row.parentNodeRunId)
  return parent !== undefined && supersededTopLevel(parent, rows)
}
