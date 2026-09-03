// RFC-353 T6（RFC-294 W4-E3）—— 技能版本提交 participant 的 **provider 装配出口**。
//
// 为什么在 composition 而不在 `public/participants`：public 面一旦直接点名
// `sqlite*` / `postgresql*` 适配器，就落进 RFC-349 的 provider-cutover 账本
// （那份账本明写「只能缩不能涨，新代码必须由 bootstrap 注入 owner 定义的端口」）。
// 所以模块之间只交换 provider 中性的合同（`SkillVersionCommitParticipantInTx` /
// `SkillVersionCommitRequest`），具体挑哪个 provider 一律在 bootstrap 或
// system-operation 根上完成。

export { composePostgresqlSkillVersionCommitParticipantFactory } from '../infrastructure/postgresqlSkillVersionCommitParticipant'
export { sqliteSkillVersionCommitSync } from '../infrastructure/sqliteSkillVersionCommitParticipant'

import { sqliteSkillVersionCommitSync as commitSync } from '../infrastructure/sqliteSkillVersionCommitParticipant'

/** SQLite 侧融合提交要的版本写入面——三处 bootstrap 根共用这一处装配。 */
export function composeSqliteFusionSkillVersionCommit(): {
  readonly commit: typeof commitSync
} {
  return Object.freeze({ commit: commitSync })
}
