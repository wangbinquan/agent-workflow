import type { MemoryDistillCommands } from './commands'

/** Closed participant used by clarify/review/feedback contexts after commit. */
export type MemoryDistillEnqueuer = Pick<MemoryDistillCommands, 'enqueue'>

// ---------------------------------------------------------------------------
// RFC-353 T3（RFC-294 W4-E3）—— memory offered 的成员关系面。
//
// 「记忆属于技能的哪一版」由 memory 单写，但**必须与技能版本写入同一事务**：
// 不变式是 fused ⟺ 该知识在技能的当前版本里，中间态被读到就是一条
// 「状态说已融合、技能里却没有这段知识」的幽灵行。所以这里给的是 tx-bound participant，
// 由调用方（技能回滚 / 融合提交）把已经开好的事务交进来，不是一个自带事务的服务。
//
// 唯一 owner 工厂是 `application/memoryMembership.ts` 的
// `createMemoryMembershipParticipantInTx`；结构等价的对象铸不出这个类型，
// 也无法被序列化后重建（RFC-294 capability-forge 守卫）。
// ---------------------------------------------------------------------------

declare const memoryMembershipParticipantInTxBrand: unique symbol

export interface MemoryMembershipUnfuseSelector {
  readonly skillId: string
  readonly aboveVersion: number
}

export interface MemoryMembershipParticipantInTx {
  readonly [memoryMembershipParticipantInTxBrand]: 'memory-membership'
  /**
   * 技能回滚到 `aboveVersion` 时，把「融入版本严格大于它」的记忆退回 approved 并清空 provenance。
   * 返回被退回的记忆 id，**字典序**（顺序由 memory domain 单一裁定，不随 provider 存储顺序漂）。
   */
  unfuseAboveVersion(selector: MemoryMembershipUnfuseSelector): Promise<readonly string[]>
}
