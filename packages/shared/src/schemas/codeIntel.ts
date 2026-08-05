// RFC-258 — code-intel contracts: a navigable source position, the symbol
// resolution (definitions + references) answered by the dual engine, and a
// single file's symbol table. Design anchors: design.md §1; gate findings
// F-04 (explicit repoKey — never inferred from a display-path prefix),
// F-05 (side: deleted rows resolve against the BASE revision),
// F-07/F-08 (honest engine/degradation/confidence reporting),
// F-09 (file symbol tables carry their completeness status).

import { z } from 'zod'
import { confidenceSchema, langIdSchema, symbolKindSchema } from './structuralDiff'

/** Which revision of the file a position points into. */
export const codeIntelSideSchema = z.enum(['base', 'worktree'])
export type CodeIntelSide = z.infer<typeof codeIntelSideSchema>

/** A navigable source position. `repoKey` is the canonical repo key ('' for a
 *  single-repo task / the root repo); on the wire it is encoded via
 *  `repoKeyWire` ('' ↔ '.'). `filePath` is repo-relative (no label prefix). */
export const codePositionSchema = z.object({
  repoKey: z.string(),
  filePath: z.string().min(1),
  side: codeIntelSideSchema,
  /** 1-based. */
  startLine: z.number().int().min(1),
  /** 1-based column of the symbol start, when known. */
  startCol: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  /** The dedented text of the target line, for list previews. */
  preview: z.string().optional(),
})
export type CodePosition = z.infer<typeof codePositionSchema>

export const codeIntelEngineSchema = z.enum(['deep', 'baseline'])
export type CodeIntelEngine = z.infer<typeof codeIntelEngineSchema>

const referenceSchema = codePositionSchema.extend({
  /** deep occurrences are 'extracted'; baseline impact heuristics are
   *  'inferred' (may both miss and over-report — F-08). Same axis as the
   *  structural diff's confidenceSchema. */
  confidence: confidenceSchema.optional(),
})
export type CodeReference = z.infer<typeof referenceSchema>

/** Answer to "what is the identifier at (file, line, col)". */
export const symbolResolutionSchema = z.object({
  requestedEngine: codeIntelEngineSchema,
  /** The engine that actually answered (deep silently degrades per file). */
  engine: codeIntelEngineSchema,
  /** Why a deep request fell back to baseline, when it did. */
  degradedReason: z.string().optional(),
  /** Canonical symbol name (SCIP symbol for deep; identifier for baseline). */
  symbol: z.string(),
  definitions: z.array(codePositionSchema),
  references: z.array(referenceSchema),
  /** References were cut at the server-side cap. */
  truncated: z.boolean().optional(),
})
export type SymbolResolution = z.infer<typeof symbolResolutionSchema>

/** One file's symbol table (full-file view anchors + baseline lookups). */
export const fileSymbolsResultSchema = z.object({
  lang: langIdSchema.nullable(),
  /** F-09 — incompleteness must be visible: 'degraded' = partial parse tree,
   *  'unsupported' = no extractor for the language, 'parse-error' = fatal. */
  status: z.enum(['ok', 'degraded', 'unsupported', 'parse-error']),
  symbols: z.array(
    z.object({
      name: z.string(),
      qualifiedName: z.string(),
      kind: symbolKindSchema,
      range: z.object({
        startLine: z.number().int().min(1),
        endLine: z.number().int().min(1),
      }),
      confidence: confidenceSchema.optional(),
    }),
  ),
})
export type FileSymbolsResult = z.infer<typeof fileSymbolsResultSchema>

// repoKey wire aliasing ('' ↔ '.') is NOT re-invented here — use the existing
// RFC-248 pair `repoKeyWire` / `parseRepoKeyWire` from repoGroupLayout (F-04).

/** LangId → shiki language id (F-13: the EXACT baseline 8, nothing else —
 *  c/csharp have no baseline grammar and are not claimed). */
const SHIKI_LANG: Record<z.infer<typeof langIdSchema>, string> = {
  typescript: 'ts',
  javascript: 'js',
  python: 'python',
  go: 'go',
  rust: 'rust',
  java: 'java',
  cpp: 'cpp',
  scala: 'scala',
}
export function shikiLangFor(lang: z.infer<typeof langIdSchema> | null): string | null {
  if (lang === null) return null
  return SHIKI_LANG[lang] ?? null
}
