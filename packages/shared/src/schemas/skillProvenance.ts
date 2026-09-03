// RFC-353 T9（RFC-294 W4-E3）—— 技能来源追溯的 wire 形状。
//
// 回答的是「这个技能的第 N 版是怎么来的、吃进了哪些知识」。纯增量：既有的
// `GET /api/skills/:id/versions` 一字未改，本合同是它旁边新开的一条只读面。

import { z } from 'zod'

import { MemoryScopeSchema } from './memory'
import { SkillVersionSourceSchema } from './skillVersion'

export const SkillProvenanceMemorySchema = z.object({
  id: z.string(),
  title: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
})
export type SkillProvenanceMemory = z.infer<typeof SkillProvenanceMemorySchema>

export const SkillProvenanceVersionSchema = z.object({
  versionIndex: z.number().int().positive(),
  source: SkillVersionSourceSchema,
  /** 仅 source='fusion' 时非空。 */
  fusionId: z.string().nullable(),
  /** 仅 source='restore' 时非空——这一版是从第几版回滚来的。 */
  restoredFromVersion: z.number().int().positive().nullable(),
  createdAt: z.number().int(),
  /**
   * 这一版吃进的、**此刻仍算数**的记忆（按 id 字典序）。
   * 非 fusion 版本恒为空；被回滚退回的记忆不再计入，也不返回当前用户看不见的记忆。
   */
  memories: z.array(SkillProvenanceMemorySchema),
})
export type SkillProvenanceVersion = z.infer<typeof SkillProvenanceVersionSchema>

export const SkillProvenanceSchema = z.object({
  skillId: z.string(),
  /** 版本倒序（最新在前），与 `GET /api/skills/:id/versions` 一致。 */
  versions: z.array(SkillProvenanceVersionSchema),
})
export type SkillProvenance = z.infer<typeof SkillProvenanceSchema>
