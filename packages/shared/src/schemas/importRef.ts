// RFC-223 — portable import reference resolution.
//
// Persisted resources use canonical ids, while agent.md and workflow YAML stay
// portable by naming referenced resources. Import is therefore an explicit
// two-step boundary: resolve every visible single match automatically, and
// require a stable resourceId selection when more than one visible owner has
// the same name.

import { z } from 'zod'
import { decodeImportSelectorRef } from '../ref/codecs'
import { ResourceVisibilitySchema } from './resourceAcl'

// RFC-243 (§5.5): 'workflow' joins for call-workflow name selectors; the
// 'workgroup' member of the design pair lands with PR-4's call-workgroup kind.
export const IMPORT_REF_TYPES = [
  'agent',
  'skill',
  'mcp',
  'plugin',
  'workflow',
  'workgroup',
] as const
export const ImportRefTypeSchema = z.enum(IMPORT_REF_TYPES)
export type ImportRefType = z.infer<typeof ImportRefTypeSchema>

export const ImportRefSelectorSchema = z
  .object({
    type: ImportRefTypeSchema,
    name: z.string().min(1).max(128),
    /** Optional portable owner hint (currently emitted by managed skill export). */
    ownerUsername: z.string().min(1).max(64).optional(),
  })
  .strict()
export type ImportRefSelector = z.infer<typeof ImportRefSelectorSchema>

/** Stable UI/service key; JSON tuple avoids delimiter collisions.
 *  RFC-282 D3 — built from the importSelector-domain AST (RFC-271 codec); the
 *  key bytes are unchanged (same JSON tuple), only the field read goes
 *  through the one decode. */
export function importRefSelectorKey(selector: ImportRefSelector): string {
  const ast = decodeImportSelectorRef(selector)
  if (ast.k !== 'selector') throw new Error('import selector decode produced a non-selector ast')
  return JSON.stringify([ast.type, ast.name, ast.ownerUsername ?? null])
}

export const ImportRefSelectionSchema = z
  .object({
    selector: ImportRefSelectorSchema,
    resourceId: z.string().min(1),
    /**
     * ACL snapshot shown alongside the candidate. The server rejects a second
     * submission when this revision changed, even if the same id is still
     * visible under the same name.
     */
    expectedAclRevision: z.number().int().nonnegative(),
  })
  .strict()
export type ImportRefSelection = z.infer<typeof ImportRefSelectionSchema>

export const ImportRefCandidateSchema = z
  .object({
    id: z.string().min(1),
    ownerUserId: z.string().nullable(),
    ownerUsername: z.string().nullable(),
    visibility: ResourceVisibilitySchema,
    aclRevision: z.number().int().nonnegative(),
  })
  .strict()
export type ImportRefCandidate = z.infer<typeof ImportRefCandidateSchema>

export const ImportRefAmbiguitySchema = z
  .object({
    selector: ImportRefSelectorSchema,
    // A normal ambiguity carries 2+ candidates. A stale explicit selection
    // returns the complete current visible candidate set (possibly empty after
    // a rename) so the UI never silently rebinds.
    candidates: z.array(ImportRefCandidateSchema),
  })
  .strict()
export type ImportRefAmbiguity = z.infer<typeof ImportRefAmbiguitySchema>
