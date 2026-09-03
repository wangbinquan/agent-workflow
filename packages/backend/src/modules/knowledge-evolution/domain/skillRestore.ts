// RFC-353 T7（RFC-294 W4-E3）—— 技能回滚时「哪些记忆要退回待用」的纯判据。
//
// 归属理由：`skills` / `skill_versions` 归 resource-catalog，`memories` 归 memory，
// 但**「记忆属于技能的哪一版」这条关系在回滚时怎么动**既不是前者的账也不是后者的账——
// 它是知识演化的规则，归 knowledge-evolution。此前它散在 RC 的 `legacy/skillVersion.ts`
// 里（SQLite）和 `postgresqlSkillContentLifecycle.prepareRestore` 里（PostgreSQL），
// 两处各写一遍同一句 `aboveVersion: request.version`。

import type { MemoryMembershipUnfuseSelector } from '../../memory/public/participants'

/**
 * 回滚到 v{target} 时要退回的那批记忆：**融入版本严格大于 target** 的。
 *
 * 不变式是 fused ⟺ 该知识在技能的当前版本里。回滚会铸一个内容等于 v{target} 的新版本，
 * 于是「在更高版本里被吃进去的知识」不再在技能里，对应的记忆必须退回 approved。
 *
 * ⚠️ **v1 已知缺口**（RFC-170 Codex P2 #4，原注释随判据一起迁来）：这里只退回
 * 「融入版本 > target」的，**不会**把「target 版本本来包含、但被更早的一次向下回滚
 * 退回过」的记忆重新标回已融合——退回时 provenance 已被清空，无从反推。于是
 * 「先回滚到 v1、再向前回滚到 v2」这条窄路径会留下一条 approved 的记忆，而它的知识
 * 其实已经回到技能里 → 轻度重复注入，不是数据丢失。完整修法是把每次融合吃进的记忆 id
 * 记在 `skill_versions` 上、回滚时按 target 的集合重新标记；见 design §10。
 */
export function memoriesToUnfuseOnRestore(input: {
  readonly skillId: string
  readonly targetVersion: number
}): MemoryMembershipUnfuseSelector {
  return { skillId: input.skillId, aboveVersion: input.targetVersion }
}
