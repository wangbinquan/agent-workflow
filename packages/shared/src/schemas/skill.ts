// Skill schemas — fs is source of truth; DB holds index only.
// Mirrors design/proposal.md §3.2 and design/design.md §3 (skills table).

import { z } from 'zod'
import { ResourceVisibilitySchema } from './resourceAcl'

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const SkillNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(SKILL_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

// RFC-178: skills are managed-only (external / parent-directory sources removed).
// The single-member enum is retained (rather than dropping the field) so the DTO
// stays stable and existing `sourceKind` reads keep compiling.
export const SkillSourceKindSchema = z.enum(['managed'])
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>

/** Skill row response. RFC-178: managed-only; `managedPath` is the files/ root. */
export const SkillSchema = z.object({
  id: z.string(),
  name: SkillNameSchema,
  description: z.string(),
  /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
  ownerUserId: z.string().nullable().optional(),
  /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
  visibility: ResourceVisibilitySchema.optional(),
  /** Monotonic ACL generation; participates in ordinary-mutation OCC fences. */
  aclRevision: z.number().int().nonnegative().optional(),
  sourceKind: SkillSourceKindSchema,
  managedPath: z.string().optional(),
  schemaVersion: z.number().int(),
  /** RFC-101: monotonic content version; equals the latest skill_versions row. */
  contentVersion: z.number().int(),
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

/**
 * Parsed SKILL.md content. `frontmatterExtra` holds frontmatter keys other
 * than `name` and `description` so they round-trip through edits.
 */
export const SkillContentSchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
  bodyMd: z.string(),
  frontmatterExtra: z.record(z.string(), z.unknown()),
  /**
   * RFC-170 §2/T3 — opaque composite precondition token
   * (base64url of [skillId, contentVersion, metaRevision]). The client holds it
   * from this read and echoes it on the eventual combined-save (T4) so the server
   * can OCC-reject a write racing another writer / a delete-recreate ABA. Optional
   * for backward compatibility: readers that predate T4 simply ignore it.
   */
  token: z.string().optional(),
})
export type SkillContent = z.infer<typeof SkillContentSchema>

/** PUT /api/skills/:id/content — overwrite SKILL.md frontmatter + body. */
export const UpdateSkillContentSchema = z.object({
  description: z.string().optional(),
  bodyMd: z.string().optional(),
  frontmatterExtra: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateSkillContent = z.infer<typeof UpdateSkillContentSchema>

/**
 * RFC-170 §2/T4 — POST /api/skills/:id/save. Combined description+body save
 * gated by the composite precondition token from the detail read (T3). A stale
 * token → 409 (skill-version-conflict); malformed → 400 (skill-token-invalid).
 */
export const CombinedSaveSkillSchema = UpdateSkillContentSchema.extend({
  expectedToken: z.string().min(1),
})
export type CombinedSaveSkill = z.infer<typeof CombinedSaveSkillSchema>

/** DELETE /api/skills/:id — type-to-confirm plus exact composite revision. */
export const DeleteSkillSchema = z
  .object({
    confirm: z.string().optional(),
    expectedToken: z.string().min(1),
    expectedAclRevision: z.number().int().nonnegative(),
  })
  .strict()
export type DeleteSkill = z.infer<typeof DeleteSkillSchema>

/** One node in the file-tree response. */
export const FileNodeSchema = z.object({
  /** Path relative to the skill's files/ root, with forward slashes. */
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().optional(),
})
export type FileNode = z.infer<typeof FileNodeSchema>

/** PUT /api/skills/:id/file?path=... body. Text-only in v1. */
export const WriteSkillFileSchema = z.object({
  content: z.string(),
  // RFC-170 F3: the composite precondition token from the detail read. When
  // present the write is OCC-fenced in the version-bump tx (same fence as
  // combined-save); the response returns the fresh token so the client's single
  // canonical token store advances. Optional for backward compatibility.
  expectedToken: z.string().min(1).optional(),
})
export type WriteSkillFile = z.infer<typeof WriteSkillFileSchema>

// ---------------------------------------------------------------------------
// RFC-019: ZIP batch import. parse end-point returns the candidate list +
// per-candidate errors; commit end-point takes a decision map keyed by
// candidate name and replays the same zip against the user's selections.
// ---------------------------------------------------------------------------

export const SkillZipErrorCodeSchema = z.enum([
  'zip-decode-failed',
  'zip-limit-exceeded',
  'zip-traversal',
  'no-skill-found',
  'skill-md-missing',
  'skill-name-invalid',
  'skill-name-duplicated-in-zip',
])
export type SkillZipErrorCode = z.infer<typeof SkillZipErrorCodeSchema>

export const SkillZipErrorSchema = z.object({
  path: z.string(),
  code: SkillZipErrorCodeSchema,
  message: z.string(),
})
export type SkillZipError = z.infer<typeof SkillZipErrorSchema>

// RFC-178: skills are managed-only, so a same-name conflict is always managed.
export const SkillZipCandidateConflictSchema = z.enum(['managed'])
export type SkillZipCandidateConflict = z.infer<typeof SkillZipCandidateConflictSchema>

/** One row in the parse response: a skill the zip could become. */
export const SkillZipCandidateViewSchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  warnings: z.array(z.string()),
  conflict: SkillZipCandidateConflictSchema.optional(),
  /**
   * RFC-102: whether the current actor may replace this same-named managed skill.
   * Only meaningful when `conflict` is set. `managed` ⇒ isResourceOwner(actor,
   * existing). Never leaks owner identity: a private same-named skill the actor
   * cannot see naturally yields false.
   */
  canOverwrite: z.boolean().optional(),
})
export type SkillZipCandidateView = z.infer<typeof SkillZipCandidateViewSchema>

export const ParseSkillZipResponseSchema = z.object({
  skills: z.array(SkillZipCandidateViewSchema),
  errors: z.array(SkillZipErrorSchema),
})
export type ParseSkillZipResponse = z.infer<typeof ParseSkillZipResponseSchema>

/** Per-candidate decision applied at commit time. */
export const SkillZipDecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('skip') }),
  z.object({ action: z.literal('overwrite') }),
  z.object({ action: z.literal('rename'), newName: SkillNameSchema }),
  z.object({ action: z.literal('import') }), // explicit new (no conflict)
])
export type SkillZipDecision = z.infer<typeof SkillZipDecisionSchema>

/** Decision map serialised by the frontend; key = original candidate name. */
export const SkillZipDecisionMapSchema = z.record(z.string(), SkillZipDecisionSchema)
export type SkillZipDecisionMap = z.infer<typeof SkillZipDecisionMapSchema>

export const SkillZipCommitFailureCodeSchema = z.enum([
  'skill-rename-conflict',
  'skill-write-failed',
  'skill-md-missing',
  'skill-name-invalid',
  // RFC-102: overwrite requested but the actor is not the owner/admin.
  'skill-overwrite-forbidden',
])
export type SkillZipCommitFailureCode = z.infer<typeof SkillZipCommitFailureCodeSchema>

export const SkillZipCommitFailureSchema = z.object({
  name: z.string(),
  code: SkillZipCommitFailureCodeSchema,
  message: z.string(),
})
export type SkillZipCommitFailure = z.infer<typeof SkillZipCommitFailureSchema>

export const SkillZipCommitSkippedSchema = z.object({
  name: z.string(),
  reason: z.string(),
})
export type SkillZipCommitSkipped = z.infer<typeof SkillZipCommitSkippedSchema>

export const CommitSkillZipResponseSchema = z.object({
  created: z.array(SkillSchema),
  updated: z.array(SkillSchema),
  skipped: z.array(SkillZipCommitSkippedSchema),
  failed: z.array(SkillZipCommitFailureSchema),
})
export type CommitSkillZipResponse = z.infer<typeof CommitSkillZipResponseSchema>
