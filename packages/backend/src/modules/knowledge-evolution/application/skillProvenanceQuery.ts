// RFC-353 T9（RFC-294 W4-E3）—— `GetSkillProvenance` 的编排。
//
// 三个来源各归其主，本文件只负责按顺序取来、过一遍可见性、再交给 domain 投影：
//   - 版本流水  → resource-catalog 的既有查询（KE 只读，不碰 `skill_versions`）；
//   - 记忆行    → memory 的只读投影 `listFusedInto`（选中判据在 memory domain）；
//   - 可见性    → memory 既有的 `filterVisible`（scope 随绑定资源可见性）；
//   - 拼装      → KE 的 `domain/skillProvenance`（四条容易漂的判断都在那里）。

import type { SkillProvenance, SkillVersion } from '@agent-workflow/shared'

import type { FusedIntoSkillMemory, MemoryScopeAuthority } from '../../memory/public/catalog'
import { projectSkillProvenance } from '../domain/skillProvenance'

export interface SkillProvenanceDeps {
  /** resource-catalog 的版本流水（调用方已确认技能对该操作者可见）。 */
  listVersions(skillId: string): Promise<SkillVersion[]>
  /** memory 的只读投影：这个技能吃进过哪些记忆。 */
  listFusedInto(skillId: string): Promise<FusedIntoSkillMemory[]>
  /** memory 既有的 scope 可见性过滤。 */
  filterVisible(rows: readonly FusedIntoSkillMemory[]): Promise<FusedIntoSkillMemory[]>
}

export async function getSkillProvenance(
  deps: SkillProvenanceDeps,
  skillId: string,
): Promise<SkillProvenance> {
  const [versions, fused] = await Promise.all([
    deps.listVersions(skillId),
    deps.listFusedInto(skillId),
  ])
  // 看不见的记忆直接不出现——**不是**留一个「N 条隐藏」的计数。来源面板是给能看到的人
  // 解释「这一版由什么组成」的，露出一个数字反而成了一个存在性 oracle 式的噪音。
  const visible = fused.length === 0 ? fused : await deps.filterVisible(fused)
  return projectSkillProvenance(skillId, versions, visible)
}

/** 路由侧的取用点：把 memory 的 authority 绑进 `filterVisible`。 */
export function bindSkillProvenanceDeps(input: {
  readonly listVersions: SkillProvenanceDeps['listVersions']
  readonly listFusedInto: SkillProvenanceDeps['listFusedInto']
  readonly filterVisible: (
    authority: MemoryScopeAuthority,
    rows: readonly FusedIntoSkillMemory[],
  ) => Promise<FusedIntoSkillMemory[]>
  readonly authority: MemoryScopeAuthority
}): SkillProvenanceDeps {
  return {
    listVersions: input.listVersions,
    listFusedInto: input.listFusedInto,
    filterVisible: (rows) => input.filterVisible(input.authority, rows),
  }
}
