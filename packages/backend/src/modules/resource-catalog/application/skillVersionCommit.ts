// RFC-353 T6（RFC-294 W4-E3）—— `SkillVersionCommitParticipantInTx` 的**唯一** owner 工厂。
//
// 「技能的版本行归 resource-catalog 单写」这条归属在 RFC-294 的表所有权里早已成立，
// 但 knowledge-evolution 的融合 `apply()` 一直是自己 `tx.update(skills)` +
// `tx.insert(skillVersions)`——跨 context 直写别人的表，两个 provider 各抄一份。
//
// 这里给的是 **tx-bound** participant：版本行必须与 KE 自己的 fusion 状态推进、与 memory 的
// 成员关系标记落在**同一个事务**里，事务只能由调用方开好交进来。形态与 memory 的
// `MemoryMembershipParticipantInTx`、source-control 的 `RepositoryScopeAuthorizationInTx` 一致
// （RFC-294 capability-forge 守卫：brand + readonly + 唯一工厂 + `Object.freeze` + 私有注册表）。

import { skillVersionCommitParticipantInTxBrand } from '../domain/participantBrands'
import type {
  SkillVersionCommitParticipantInTx,
  SkillVersionCommitRequest,
} from '../public/participants'

/**
 * 各 provider 只需提供这一件事：在给定事务里做复合前置条件重验、推进 `skills`、
 * 落 `skill_versions` 行，返回新版本号。
 *
 * **刻意不放在 `public/`**：调用方只认识铸好的 capability，不认识写入面
 * （RFC-294 design §3.3「无 consumer 不公开」）。
 */
export interface SkillVersionCommitWrites {
  commit(request: SkillVersionCommitRequest): Promise<number>
}

/** 私有运行时注册表：只有经本工厂铸出的实例才在册，结构等价的对象不在。 */
const trustedSkillVersionCommitParticipants = new WeakSet<object>()

export function isTrustedSkillVersionCommitParticipant(value: object): boolean {
  return trustedSkillVersionCommitParticipants.has(value)
}

export function createSkillVersionCommitParticipantInTx(
  writes: SkillVersionCommitWrites,
): SkillVersionCommitParticipantInTx {
  const participant = Object.freeze({
    [skillVersionCommitParticipantInTxBrand]: 'skill-version-commit' as const,
    commit(request: SkillVersionCommitRequest) {
      return writes.commit(request)
    },
  })
  trustedSkillVersionCommitParticipants.add(participant)
  return participant
}
