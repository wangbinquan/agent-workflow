// RFC-223 — portable import reference resolution.
//
// Persisted resources use canonical ids, while agent.md and workflow YAML stay
// portable by naming referenced resources. Import is therefore an explicit
// two-step boundary: resolve every visible single match automatically, and
// require a stable resourceId selection when more than one visible owner has
// the same name.

import { z } from 'zod'
import { ResourceVisibilitySchema } from './resourceAcl'

export const IMPORT_REF_TYPES = ['agent', 'skill', 'mcp', 'plugin'] as const
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

/** Stable UI/service key; JSON tuple avoids delimiter collisions. */
export function importRefSelectorKey(selector: ImportRefSelector): string {
  return JSON.stringify([selector.type, selector.name, selector.ownerUsername ?? null])
}

export const ImportRefSelectionSchema = z
  .object({
    selector: ImportRefSelectorSchema,
    resourceId: z.string().min(1),
  })
  .strict()
export type ImportRefSelection = z.infer<typeof ImportRefSelectionSchema>

export const ImportRefCandidateSchema = z
  .object({
    id: z.string().min(1),
    ownerUserId: z.string().nullable(),
    ownerUsername: z.string().nullable(),
    visibility: ResourceVisibilitySchema,
  })
  .strict()
export type ImportRefCandidate = z.infer<typeof ImportRefCandidateSchema>

export const ImportRefAmbiguitySchema = z
  .object({
    selector: ImportRefSelectorSchema,
    // A normal ambiguity carries 2+ candidates. A stale explicit selection
    // may return the now-current single candidate so the UI can require a
    // fresh user confirmation instead of silently rebinding.
    candidates: z.array(ImportRefCandidateSchema).min(1),
  })
  .strict()
export type ImportRefAmbiguity = z.infer<typeof ImportRefAmbiguitySchema>
