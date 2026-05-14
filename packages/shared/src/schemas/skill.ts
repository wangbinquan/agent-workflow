// Skill schemas — fs is source of truth; DB holds index only.
// Mirrors design/proposal.md §3.2 and design/design.md §3 (skills table).

import { z } from 'zod'

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const SkillNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(SKILL_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

export const SkillSourceKindSchema = z.enum(['managed', 'external'])
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>

/** Skill row response. `managedPath` set iff `managed`, `externalPath` set iff `external`. */
export const SkillSchema = z.object({
  id: z.string(),
  name: SkillNameSchema,
  description: z.string(),
  sourceKind: SkillSourceKindSchema,
  managedPath: z.string().optional(),
  externalPath: z.string().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Skill = z.infer<typeof SkillSchema>

/** POST /api/skills — create a managed skill. Writes SKILL.md to disk. */
export const CreateManagedSkillSchema = z.object({
  name: SkillNameSchema,
  description: z.string().default(''),
  bodyMd: z.string().default(''),
  frontmatterExtra: z.record(z.string(), z.unknown()).default({}),
})
export type CreateManagedSkill = z.infer<typeof CreateManagedSkillSchema>

/** POST /api/skills/import-external — register an existing on-disk skill dir. */
export const ImportExternalSkillSchema = z.object({
  name: SkillNameSchema,
  externalPath: z.string().min(1),
  description: z.string().default(''),
})
export type ImportExternalSkill = z.infer<typeof ImportExternalSkillSchema>

/** PUT /api/skills/:name — update DB-only metadata. */
export const UpdateSkillSchema = z.object({
  description: z.string().optional(),
})
export type UpdateSkill = z.infer<typeof UpdateSkillSchema>

/**
 * Parsed SKILL.md content. `frontmatterExtra` holds frontmatter keys other
 * than `name` and `description` so they round-trip through edits.
 */
export const SkillContentSchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
  bodyMd: z.string(),
  frontmatterExtra: z.record(z.string(), z.unknown()),
})
export type SkillContent = z.infer<typeof SkillContentSchema>

/** PUT /api/skills/:name/content — overwrite SKILL.md frontmatter + body. */
export const UpdateSkillContentSchema = z.object({
  description: z.string().optional(),
  bodyMd: z.string().optional(),
  frontmatterExtra: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateSkillContent = z.infer<typeof UpdateSkillContentSchema>

/** One node in the file-tree response. */
export const FileNodeSchema = z.object({
  /** Path relative to the skill's files/ root, with forward slashes. */
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().optional(),
})
export type FileNode = z.infer<typeof FileNodeSchema>

/** PUT /api/skills/:name/file?path=... body. Text-only in v1. */
export const WriteSkillFileSchema = z.object({
  content: z.string(),
})
export type WriteSkillFile = z.infer<typeof WriteSkillFileSchema>
