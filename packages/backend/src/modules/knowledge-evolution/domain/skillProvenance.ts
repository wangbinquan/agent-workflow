// RFC-353 T9（RFC-294 W4-E3）—— 技能来源追溯的**纯投影**：把版本流水与记忆按版本对起来。
//
// 归属：`skill_versions` 的行归 resource-catalog，`memories` 的行归 memory，
// 但「这两者怎么拼成一条『第 N 版是怎么来的』」是知识演化的事，归 knowledge-evolution。
//
// 之所以做成纯函数：这条投影有四个容易各自漂的判断——非 fusion 版本该不该有记忆、
// 已解融合的记忆算不算数、不可见的记忆怎么处理、版本按什么序返回。写在
// 路由 handler 里就没法单独锁；抽成纯函数后每一条都能直接断言。

import type { SkillProvenance, SkillProvenanceVersion, SkillVersion } from '@agent-workflow/shared'

/** 投影要的记忆行——调用方已按可见性过滤过，这里只按版本分组。 */
export interface ProvenanceMemoryRow {
  readonly id: string
  readonly title: string
  readonly scopeType: SkillProvenanceVersion['memories'][number]['scopeType']
  readonly scopeId: string | null
  readonly fusedIntoSkillVersion: number
}

/**
 * 拼出来源视图。
 *
 * - **版本倒序**（最新在前），与 `GET /api/skills/:id/versions` 一致——两条面并排展示时
 *   顺序必须一样，否则用户会以为看的是两个不同的东西；
 * - 记忆按 `fusedIntoSkillVersion` 归到对应版本；归不到任何版本的行（版本已被删、
 *   或指向更高的版本号）不出现——来源面板是「这一版由什么组成」，不是记忆的全量流水；
 * - **非 fusion 版本恒为空**：`restore` / `editor` / `import` / `initial` 不吃记忆。
 *   即便有历史脏数据把记忆指到这样的版本上，也不在这里展示——那是 RFC-223 provenance
 *   修复该管的事，不是把脏数据顺手渲染出来。
 */
export function projectSkillProvenance(
  skillId: string,
  versions: readonly SkillVersion[],
  memories: readonly ProvenanceMemoryRow[],
): SkillProvenance {
  const byVersion = new Map<number, ProvenanceMemoryRow[]>()
  for (const memory of memories) {
    const bucket = byVersion.get(memory.fusedIntoSkillVersion)
    if (bucket === undefined) byVersion.set(memory.fusedIntoSkillVersion, [memory])
    else bucket.push(memory)
  }
  const ordered = [...versions].sort((left, right) => right.versionIndex - left.versionIndex)
  return {
    skillId,
    versions: ordered.map((version) => ({
      versionIndex: version.versionIndex,
      source: version.source,
      fusionId: version.fusionId,
      restoredFromVersion: version.restoredFromVersion,
      createdAt: version.createdAt,
      memories:
        version.source === 'fusion'
          ? (byVersion.get(version.versionIndex) ?? []).map((memory) => ({
              id: memory.id,
              title: memory.title,
              scopeType: memory.scopeType,
              scopeId: memory.scopeId,
            }))
          : [],
    })),
  }
}
