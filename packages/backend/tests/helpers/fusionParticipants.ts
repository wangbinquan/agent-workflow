// RFC-353 T6/T7 —— 测试用的 fusion 跨聚合装配。
//
// 生产上这两半（memory 的成员关系、resource-catalog 的版本提交）由 bootstrap 注入：
// 模块之间只能经 exact `public/*` 交换合同（RFC-317 R2），而 public 面又不许直接点名
// provider 适配器（RFC-349 provider-cutover 账本「只能缩不能涨」），两条约束叠起来
// 只剩「跨 context 的 provider 装配在根上完成」这一个自洽解。
//
// 测试给的就是生产同一份装配，不是 stub——否则这些用例会退化成「只验 fusion 表」。

import {
  composeSkillMemoryFusionParticipantFactory,
  composeSqliteFusionMemoryMembership,
} from '../../src/modules/memory/composition'
import {
  composePostgresqlSkillVersionCommitParticipantFactory,
  composeSqliteFusionSkillVersionCommit,
} from '../../src/modules/resource-catalog/composition/skillVersionCommit'

export const TEST_SQLITE_FUSION_PARTICIPANTS = Object.freeze({
  memoryMembership: composeSqliteFusionMemoryMembership(),
  skillVersionCommit: composeSqliteFusionSkillVersionCommit(),
})

export const TEST_POSTGRESQL_FUSION_PARTICIPANTS = Object.freeze({
  memoryMembership: composeSkillMemoryFusionParticipantFactory(),
  skillVersionCommit: composePostgresqlSkillVersionCommitParticipantFactory(),
})
