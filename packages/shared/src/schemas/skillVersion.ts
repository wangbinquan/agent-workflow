// RFC-101 — skill content version history schemas.
// One immutable snapshot per (skill, version_index). Disk holds the archived
// files/ tree under skills/{name}/versions/v{n}/files; DB holds metadata.

import { z } from 'zod'
import { FileNodeSchema, SkillContentSchema } from './skill'

export const SkillVersionSourceSchema = z.enum(['initial', 'editor', 'fusion', 'restore'])
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

/** GET /api/skills/:name/versions/:v/content — parsed SKILL.md + file tree of a past version. */
export const SkillVersionContentSchema = z.object({
  versionIndex: z.number().int().positive(),
  content: SkillContentSchema,
  files: z.array(FileNodeSchema),
})
export type SkillVersionContent = z.infer<typeof SkillVersionContentSchema>

/** GET /api/skills/:name/versions/diff?from=&to= — git-style unified diff. */
export const SkillVersionDiffSchema = z.object({
  from: z.number().int().positive(),
  to: z.number().int().positive(),
  diff: z.string(),
})
export type SkillVersionDiff = z.infer<typeof SkillVersionDiffSchema>

/** POST /api/skills/:name/versions/:v/restore body. */
export const RestoreSkillVersionSchema = z.object({
  /** Optional human note recorded on the new (restore) version row. */
  reason: z.string().max(2000).optional(),
  // RFC-170 F3: composite precondition token — OCC-fences the restore in the
  // version-bump tx; the response returns the fresh token. Optional for
  // backward compatibility.
  expectedToken: z.string().min(1).optional(),
})
export type RestoreSkillVersion = z.infer<typeof RestoreSkillVersionSchema>
