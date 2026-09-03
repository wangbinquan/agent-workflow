// RFC-353 T3（RFC-294 W4-E3）—— `MemoryMembershipParticipantInTx` 的**唯一** owner 工厂。
//
// design §638 把 `MemoryMembershipParticipantInTx` 列为 memory offered、knowledge-evolution-only
// 的面：「记忆属于技能的哪一版」这条关系由 memory 单写，但必须与技能版本写入**同一事务**
// ——不变式是 fused ⟺ 该知识在技能的当前版本里，中间态被读到就是一条
// 「状态说已融合、技能里却没有这段知识」的幽灵行。
//
// 与 RFC-352 给 source-control 落的 `RepositoryScopeAuthorizationInTx` 同形：capability 类型带
// 私有 brand，只能由这一个工厂铸造（RFC-294 capability-forge 守卫要求 brand + readonly +
// 唯一工厂 + `Object.freeze` + 私有运行时注册表）。provider 差异被收窄到「怎么把这批行读出来、
// 怎么把这组列写回去」这一件事（`MemoryMembershipWrites`），它不是 capability，
// 两个 provider 各实现一份；**判据（选中规则与返回顺序）只有 `domain/fusionMembership` 那一处**。
//
// 为什么要有这个工厂：在它之前，PostgreSQL 侧的技能回滚已经经参与者注入拿到 memory 的半边，
// SQLite 侧却是 resource-catalog 的 `legacy/skillVersion.ts` 直接
// `import { unfuseMemoriesTx } from '@/services/memory'`——同一件事两条取用路径，
// 其中一条还穿过一个 legacy facade。

import type {
  MemoryMembershipParticipantInTx,
  MemoryMembershipUnfuseSelector,
} from '../public/participants'

/**
 * 各 provider 只需提供这一件事：按 selector 退回这批记忆，返回被退回的 id。
 *
 * **刻意不放在 `public/`**：调用方（knowledge-evolution / resource-catalog 的回滚路径）
 * 从不认识它，对外合同只有铸好的 capability；放进 public 会多一个零 consumer 的公共符号
 * （RFC-294 design §3.3「无 consumer 不公开」）。
 */
export interface MemoryMembershipWrites {
  unfuseAboveVersion(selector: MemoryMembershipUnfuseSelector): Promise<readonly string[]>
}

/**
 * 私有运行时注册表：只有经本工厂铸出的实例才在册。结构等价的对象即便通过了类型断言，
 * 也不在这个 WeakSet 里——与 source-control 的 `trustedRepositoryScopeAuthorizations` 同形。
 */
const trustedMemoryMembershipParticipants = new WeakSet<object>()

export function isTrustedMemoryMembershipParticipant(value: object): boolean {
  return trustedMemoryMembershipParticipants.has(value)
}

export function createMemoryMembershipParticipantInTx(
  writes: MemoryMembershipWrites,
): MemoryMembershipParticipantInTx {
  const participant = Object.freeze({
    unfuseAboveVersion(selector: MemoryMembershipUnfuseSelector) {
      return writes.unfuseAboveVersion(selector)
    },
  }) as unknown as MemoryMembershipParticipantInTx
  trustedMemoryMembershipParticipants.add(participant)
  return participant
}
