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

export interface MemoryMembershipFuseCommand {
  readonly memoryIds: readonly string[]
  readonly skillId: string
  readonly skillName: string
  readonly skillVersion: number
  readonly fusionId: string
  readonly actorUserId: string
  readonly now: number
}

export interface MemoryMembershipParticipantInTx {
  readonly [memoryMembershipParticipantInTxBrand]: 'memory-membership'
  /**
   * 技能回滚到 `aboveVersion` 时，把「融入版本严格大于它」的记忆退回 approved 并清空 provenance。
   * 返回被退回的记忆 id，**字典序**（顺序由 memory domain 单一裁定，不随 provider 存储顺序漂）。
   */
  unfuseAboveVersion(selector: MemoryMembershipUnfuseSelector): Promise<readonly string[]>

  /**
   * 融合提交：把这批候选里仍是 `approved` 的记忆标记为已融合并写入 provenance。
   * 返回真正被标记的 id，**字典序**。候选里已经不是 approved 的会被跳过——那是真实分支
   * （审批之间记忆可能被归档、被别的融合吃掉），不是防御性代码。
   */
  markFused(command: MemoryMembershipFuseCommand): Promise<readonly string[]>
}

// ---------------------------------------------------------------------------
// RFC-353 T6 —— 成员关系的**铸造入口**也从 public 出。
//
// 形态照 RFC-352 给 source-control 的 `RepositoryScopeAuthorizationInTx`：唯一 owner 工厂与
// 两个 provider 的实现一起经 `public/participants` 出口，消费方（knowledge-evolution）
// 从这里取，而不是深入 memory 的 `composition.ts` / `infrastructure/*`——后者是跨 context
// 内部 import，RFC-317 R2 明令禁止。
//
// 为什么这里出现 provider 形状（`DbTxSync` / PostgreSQL 事务）：融合提交与技能回滚都要求
// 「记忆成员关系与技能版本写入同一事务」，事务只能由调用方开、交进来。这与 SC 那条
// `sqliteRepositoryScopeExistenceReads` 是同一类已登记的存量债，不是新形态。
// ---------------------------------------------------------------------------

export {
  markFusedSync,
  reassignFusedSkillSync,
  sqliteMemoryMembershipWrites,
  unfuseAboveVersionSync,
} from '../infrastructure/sqliteMemoryMembershipParticipant'
export {
  composePostgresqlFusedSkillReassignment,
  composePostgresqlSkillMemoryFusionParticipantFactory,
} from '../infrastructure/postgresqlSkillMemoryFusionParticipant'
export { createMemoryMembershipParticipantInTx } from '../application/memoryMembership'
