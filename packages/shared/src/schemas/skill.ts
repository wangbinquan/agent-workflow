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

export const SkillSourceKindSchema = z.enum(['managed', 'external'])
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>

/**
 * RFC-170 (G3-7/G5-P2) — stable content-authority discriminator, distinct from
 * the coarse `sourceKind`. Drives the three-state capability table (who may edit
 * description / delete / transfer ownership):
 *   - `managed`         — platform snapshot is authoritative; fully editable.
 *   - `source-external` — a registered source dir owns the SKILL.md; metadata
 *     write AND owner transfer are blocked (the registrar controls content).
 *   - `hand-external`   — a hand-imported dir; DB metadata is editable, but owner
 *     transfer is still blocked (the original importer controls content).
 * NOT derivable from `sourceId != null` (FK ON DELETE would misclassify orphans).
 */
export const SkillAuthorityKindSchema = z.enum(['managed', 'source-external', 'hand-external'])
export type SkillAuthorityKind = z.infer<typeof SkillAuthorityKindSchema>

/** Skill row response. `managedPath` set iff `managed`, `externalPath` set iff `external`. */
export const SkillSchema = z.object({
  id: z.string(),
  name: SkillNameSchema,
  description: z.string(),
  /** RFC-099 ACL — owner (users.id or '__system__'); null until first owner write. */
  ownerUserId: z.string().nullable().optional(),
  /** RFC-099 ACL — 'public' = every user; 'private' = owner + grants. Absent ⇒ 'public'. */
  visibility: ResourceVisibilitySchema.optional(),
  sourceKind: SkillSourceKindSchema,
  /**
   * RFC-170 (G5-P2) — stable content-authority discriminator; drives the
   * frontend three-state capability table. Optional on the wire for fixture
   * back-compat; the backend always populates it. Absent ⇒ derive from
   * `sourceKind` (managed → 'managed', external → 'hand-external').
   */
  authorityKind: SkillAuthorityKindSchema.optional(),
  managedPath: z.string().optional(),
  externalPath: z.string().optional(),
  /**
   * RFC-017: when this skill was discovered by reconciling a registered
   * `skill_sources` parent directory, the source row's id is carried here.
   * Hand-imported managed/external skills leave this unset.
   */
  sourceId: z.string().optional(),
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

/** PUT /api/skills/:name/content — overwrite SKILL.md frontmatter + body. */
export const UpdateSkillContentSchema = z.object({
  description: z.string().optional(),
  bodyMd: z.string().optional(),
  frontmatterExtra: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateSkillContent = z.infer<typeof UpdateSkillContentSchema>

/**
 * RFC-170 §2/T4 — POST /api/skills/:name/save. Combined description+body save
 * gated by the composite precondition token from the detail read (T3). A stale
 * token → 409 (skill-version-conflict); malformed → 400 (skill-token-invalid).
 */
export const CombinedSaveSkillSchema = UpdateSkillContentSchema.extend({
  expectedToken: z.string().min(1),
})
export type CombinedSaveSkill = z.infer<typeof CombinedSaveSkillSchema>

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

// ---------------------------------------------------------------------------
// RFC-017: Skill sources (parent directories whose direct children are
// auto-imported as external skills, reconciled lazily on each list request).
// ---------------------------------------------------------------------------

/** Persisted skill_sources row exposed via API. */
export const SkillSourceSchema = z.object({
  id: z.string(),
  /** Absolute, canonicalized (`realpath`) parent directory path. */
  path: z.string(),
  /** Display label; defaults to basename(path) when not supplied. */
  label: z.string(),
  enabled: z.boolean(),
  lastScannedAt: z.number().int().nullable(),
  lastScanError: z.string().nullable(),
  /** RFC-099 (D11) — who registered this source; its imported skills inherit this owner. */
  createdBy: z.string().nullable().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type SkillSource = z.infer<typeof SkillSourceSchema>

export const SkillSkipReasonSchema = z.enum([
  'no-skill-md',
  'invalid-name',
  'name-conflict-manual',
  'name-conflict-source',
  'frontmatter-parse-failed',
  'still-referenced',
])
export type SkillSkipReason = z.infer<typeof SkillSkipReasonSchema>

export const SkillSkipReportSchema = z.object({
  childPath: z.string(),
  proposedName: z.string().optional(),
  reason: SkillSkipReasonSchema,
  detail: z.string().optional(),
})
export type SkillSkipReport = z.infer<typeof SkillSkipReportSchema>

export const SkillSourceWithStatsSchema = SkillSourceSchema.extend({
  childCount: z.number().int().nonnegative(),
  skipped: z.array(SkillSkipReportSchema),
})
export type SkillSourceWithStats = z.infer<typeof SkillSourceWithStatsSchema>

/** POST /api/skill-sources body. */
export const CreateSkillSourceSchema = z.object({
  path: z.string().min(1),
  label: z.string().optional(),
})
export type CreateSkillSource = z.infer<typeof CreateSkillSourceSchema>

/** PATCH /api/skill-sources/:id body. */
export const UpdateSkillSourceSchema = z.object({
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
})
export type UpdateSkillSource = z.infer<typeof UpdateSkillSourceSchema>

/** POST /api/skill-sources response shape. */
export const RegisterSkillSourceResponseSchema = z.object({
  source: SkillSourceWithStatsSchema,
  imported: z.array(SkillSchema),
  skipped: z.array(SkillSkipReportSchema),
})
export type RegisterSkillSourceResponse = z.infer<typeof RegisterSkillSourceResponseSchema>

/** POST /api/skill-sources/:id/rescan response shape. */
export const RescanSkillSourceResponseSchema = z.object({
  source: SkillSourceWithStatsSchema,
  imported: z.array(SkillSchema),
  deleted: z.array(z.string()),
  skipped: z.array(SkillSkipReportSchema),
})
export type RescanSkillSourceResponse = z.infer<typeof RescanSkillSourceResponseSchema>

/**
 * RFC-102: POST /api/skill-sources/:id/conflicts/replace body. Resolve a
 * `name-conflict-*` by replacing the occupying skill with this source's version
 * of `name` (requires write permission on the occupying skill).
 */
export const ReplaceSourceConflictSchema = z.object({ name: SkillNameSchema })
export type ReplaceSourceConflict = z.infer<typeof ReplaceSourceConflictSchema>

export const ReplaceSourceConflictResponseSchema = z.object({
  source: SkillSourceWithStatsSchema,
  replaced: z.string(),
  imported: SkillSchema,
})
export type ReplaceSourceConflictResponse = z.infer<typeof ReplaceSourceConflictResponseSchema>

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

export const SkillZipCandidateConflictSchema = z.enum(['managed', 'external'])
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
   * RFC-102: whether the current actor may replace this same-named skill.
   * Only meaningful when `conflict` is set. `external` ⇒ always false (the
   * skill's source of truth lives on disk; a zip cannot overwrite it).
   * `managed` ⇒ isResourceOwner(actor, existing). Never leaks owner identity:
   * a private same-named skill the actor cannot see naturally yields false.
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
  'skill-external-cannot-overwrite',
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
