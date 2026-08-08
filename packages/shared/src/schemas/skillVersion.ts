// RFC-101 — skill content version history schemas.
// One immutable snapshot per (skill, version_index). Disk holds the archived
// files/ tree under skills/{name}/versions/v{n}/files; DB holds metadata.

import { z } from 'zod'
import { FileNodeSchema, SkillContentSchema } from './skill'

/**
 * RFC-271 T10 —— 扩了一个 `'import'`（配置包导入写入的版本）。
 *
 * 不复用 `'editor'`：`source` 这一列的全部意义就是**溯源**，而库里没有第二个
 * 地方记「这次内容是从哪来的」。把包导入记成 editor，等于让版本历史说谎——
 * 用户回看时无从分辨「谁在编辑器里改的」与「一次导入覆盖了它」。
 * 该列**没有** DB CHECK 约束（纯 TS 侧枚举），故扩它零迁移。
 */
export const SkillVersionSourceSchema = z.enum(['initial', 'editor', 'fusion', 'restore', 'import'])
export type SkillVersionSource = z.infer<typeof SkillVersionSourceSchema>

/** A single skill_versions row, projected for the API. */
export const SkillVersionSchema = z.object({
  id: z.string(),
  skillName: z.string(),
  versionIndex: z.number().int().positive(),
  source: SkillVersionSourceSchema,
  summary: z.string().nullable(),
  /** Set when source='fusion' (RFC-101 PR-B). */
  fusionId: z.string().nullable(),
  /** Set when source='restore' — the version this one was restored from. */
  restoredFromVersion: z.number().int().positive().nullable(),
  authorUserId: z.string().nullable(),
  contentHash: z.string().nullable(),
  createdAt: z.number().int(),
})
export type SkillVersion = z.infer<typeof SkillVersionSchema>

/** GET /api/skills/:id/versions/:v/content — parsed SKILL.md + file tree of a past version. */
export const SkillVersionContentSchema = z.object({
  versionIndex: z.number().int().positive(),
  content: SkillContentSchema,
  files: z.array(FileNodeSchema),
})
export type SkillVersionContent = z.infer<typeof SkillVersionContentSchema>

/** GET /api/skills/:id/versions/diff?from=&to= — git-style unified diff. */
export const SkillVersionDiffSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  diff: z.string(),
})
export type SkillVersionDiff = z.infer<typeof SkillVersionDiffSchema>

/** POST /api/skills/:id/versions/:v/restore body. */
export const RestoreSkillVersionSchema = z.object({
  /** Optional human note recorded on the new (restore) version row. */
  reason: z.string().max(2000).optional(),
  // RFC-170 F3: composite precondition token — OCC-fences the restore in the
  // version-bump tx; the response returns the fresh token. Optional for
  // backward compatibility.
  expectedToken: z.string().min(1).optional(),
})
export type RestoreSkillVersion = z.infer<typeof RestoreSkillVersionSchema>
