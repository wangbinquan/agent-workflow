// RFC-083 — structural (semantic) diff artifact: shared types + zod schemas.
//
// The platform captures an agent's code change as a textual unified diff today
// (gitDiffSnapshot). This module is the wire/type contract for the STRUCTURAL
// overlay: parse before/after blobs into a symbol graph (file → class → method
// → field, plus import/call/inherit edges) and set-diff them so a human sees
// "method foo added / field x removed / new dependency on tokio" instead of raw
// hunks.
//
// Pure data only (imports just zod). The graph set-diff ALGORITHM lives in the
// dependency-free leaf `../structuralDiffGraph.ts` so the barrel can re-export
// it without dragging any registry-coupled module into a module-init cycle
// (RFC-079 lesson). Keep this file free of cross-package imports.

import { z } from 'zod'

// -----------------------------------------------------------------------------
// Languages
// -----------------------------------------------------------------------------

/** The 8 first-class languages RFC-083 targets. */
export const langIdSchema = z.enum([
  'cpp',
  'java',
  'python',
  'rust',
  'go',
  'javascript',
  'typescript',
  'scala',
])
export type LangId = z.infer<typeof langIdSchema>

/** A changed file's resolved language, or 'unknown' when no grammar matches. */
export const fileLangSchema = z.union([langIdSchema, z.literal('unknown')])
export type FileLang = z.infer<typeof fileLangSchema>

// -----------------------------------------------------------------------------
// Symbol nodes
// -----------------------------------------------------------------------------

export const symbolKindSchema = z.enum([
  'file',
  'module',
  'namespace',
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'function',
  'method',
  'constructor',
  'field',
  'property',
  'constant',
  'import',
])
export type SymbolKind = z.infer<typeof symbolKindSchema>

/** graphify's confidence axis — surfaced so best-effort (C++/Scala, inferred
 *  call edges) can be visually distinguished from precise (extracted) facts. */
export const confidenceSchema = z.enum(['extracted', 'inferred', 'ambiguous'])
export type Confidence = z.infer<typeof confidenceSchema>

export const sourceRangeSchema = z.object({
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
})
export type SourceRange = z.infer<typeof sourceRangeSchema>

export const symbolNodeSchema = z.object({
  /** Stable id: `${filePath}#${qualifiedName}:${kind}` (+ disambiguator). */
  id: z.string().min(1),
  kind: symbolKindSchema,
  name: z.string(),
  /** Scope-qualified name, e.g. `OrderService.charge`. */
  qualifiedName: z.string(),
  /** Normalized declaration signature (params/return), used for modify detect. */
  signature: z.string().optional(),
  /** Hash of the symbol's own body (leaf) or declaration (container). Drives
   *  modify/rename detection. Extraction decides what text feeds the hash. */
  bodyHash: z.string().optional(),
  lang: langIdSchema,
  filePath: z.string(),
  range: sourceRangeSchema.optional(),
  /** Container symbol id (a method's class), for tree nesting. */
  parentId: z.string().optional(),
  confidence: confidenceSchema.default('extracted'),
  /** True when produced by a best-effort grammar (C++/Scala baseline). */
  degraded: z.boolean().optional(),
})
export type SymbolNode = z.infer<typeof symbolNodeSchema>

// -----------------------------------------------------------------------------
// Changes
// -----------------------------------------------------------------------------

export const changeTypeSchema = z.enum(['added', 'removed', 'modified', 'renamed', 'moved'])
export type ChangeType = z.infer<typeof changeTypeSchema>

export const hunkAnchorSchema = z.object({
  filePath: z.string(),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
})
export type HunkAnchor = z.infer<typeof hunkAnchorSchema>

export const symbolChangeSchema = z.object({
  changeType: changeTypeSchema,
  kind: symbolKindSchema,
  before: symbolNodeSchema.optional(),
  after: symbolNodeSchema.optional(),
  /** Declaration signature differs (params/return changed). */
  signatureChanged: z.boolean().optional(),
  /** Symbol body text differs (bodyHash mismatch). */
  bodyChanged: z.boolean().optional(),
  /** RFC-083 logic detail (#6): how much of a modified callable's body changed,
   *  as line-level added/removed counts (heuristic line multiset diff). */
  bodyDelta: z
    .object({
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    })
    .optional(),
  /** For renamed/moved: the prior qualifiedName. */
  renamedFrom: z.string().optional(),
  /** Where to jump in the textual diff for this symbol. */
  hunkAnchor: hunkAnchorSchema.optional(),
})
export type SymbolChange = z.infer<typeof symbolChangeSchema>

// -----------------------------------------------------------------------------
// Edges (relationship graph; feeds dependency + impact)
// -----------------------------------------------------------------------------

export const edgeKindSchema = z.enum([
  'contains',
  'calls',
  'imports',
  'inherits',
  'implements',
  'references',
])
export type EdgeKind = z.infer<typeof edgeKindSchema>

export const symbolEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: edgeKindSchema,
  confidence: confidenceSchema.default('extracted'),
  changeType: z.enum(['added', 'removed']).optional(),
})
export type SymbolEdge = z.infer<typeof symbolEdgeSchema>

// -----------------------------------------------------------------------------
// Dependency changes
// -----------------------------------------------------------------------------

export const ecosystemSchema = z.enum([
  'cargo',
  'go',
  'npm',
  'maven',
  'gradle',
  'sbt',
  'pip',
  'poetry',
  'cmake',
  'vcpkg',
  'conan',
])
export type Ecosystem = z.infer<typeof ecosystemSchema>

export const dependencyChangeSchema = z.object({
  ecosystem: ecosystemSchema,
  packageName: z.string(),
  changeType: z.enum(['added', 'removed', 'updated']),
  versionBefore: z.string().optional(),
  versionAfter: z.string().optional(),
  /** Set when found via manifest/lock set-diff. */
  viaManifest: z.boolean().default(false),
  /** Set when a new source import resolves to this package. */
  viaImport: z.boolean().default(false),
  manifestPath: z.string().optional(),
})
export type DependencyChange = z.infer<typeof dependencyChangeSchema>

// -----------------------------------------------------------------------------
// Impact (deep mode only)
// -----------------------------------------------------------------------------

export const impactCallerSchema = z.object({
  symbolId: z.string().optional(),
  filePath: z.string(),
  range: sourceRangeSchema,
})
export type ImpactCaller = z.infer<typeof impactCallerSchema>

export const impactItemSchema = z.object({
  changedSymbolId: z.string(),
  callers: z.array(impactCallerSchema),
  confidence: confidenceSchema.default('extracted'),
})
export type ImpactItem = z.infer<typeof impactItemSchema>

// -----------------------------------------------------------------------------
// Per-file + top-level artifact
// -----------------------------------------------------------------------------

export const fileAnalysisStatusSchema = z.enum([
  'ok',
  'degraded', // best-effort grammar (C++/Scala)
  'skipped-binary',
  'skipped-oversized',
  'unsupported', // no grammar for this extension
  'parse-error',
])
export type FileAnalysisStatus = z.infer<typeof fileAnalysisStatusSchema>

export const fileStructuralDiffSchema = z.object({
  filePath: z.string(),
  lang: fileLangSchema,
  status: fileAnalysisStatusSchema,
  changes: z.array(symbolChangeSchema).default([]),
  edges: z.array(symbolEdgeSchema).default([]),
  /** Within-file blast-radius: callers of this file's changed methods. The
   *  top-level StructuralDiff.impact is the flattened union of these. Empty
   *  unless impact analysis ran (baseline = within-file, heuristic). */
  impact: z.array(impactItemSchema).default([]),
})
export type FileStructuralDiff = z.infer<typeof fileStructuralDiffSchema>

export const engineSchema = z.enum(['baseline', 'deep'])
export type Engine = z.infer<typeof engineSchema>

export const analysisStatusSchema = z.enum(['ok', 'partial', 'pruned', 'failed'])
export type AnalysisStatus = z.infer<typeof analysisStatusSchema>

export const structuralScopeSchema = z.enum(['task', 'node', 'wrapper'])
export type StructuralScope = z.infer<typeof structuralScopeSchema>

/** Aggregated +~−rename counts per symbol category, for the summary cards. */
export const changeCountSchema = z.object({
  added: z.number().int().nonnegative().default(0),
  modified: z.number().int().nonnegative().default(0),
  removed: z.number().int().nonnegative().default(0),
  renamed: z.number().int().nonnegative().default(0),
})
export type ChangeCount = z.infer<typeof changeCountSchema>

export const structuralDiffSummarySchema = z.object({
  files: z.number().int().nonnegative(),
  classes: changeCountSchema, // class/interface/trait/struct/enum/object
  methods: changeCountSchema, // function/method/constructor
  fields: changeCountSchema, // field/property/constant
  imports: changeCountSchema,
  dependencies: changeCountSchema,
})
export type StructuralDiffSummary = z.infer<typeof structuralDiffSummarySchema>

export const classEdgeKindSchema = z.enum(['inherits', 'references'])
export type ClassEdgeKind = z.infer<typeof classEdgeKindSchema>

export const classEdgeSchema = z.object({
  /** `${filePath}::${qualifiedName}` of the referencing class. */
  from: z.string(),
  /** `${filePath}::${qualifiedName}` of the referenced class. */
  to: z.string(),
  kind: classEdgeKindSchema,
  /** For 'references': symbol ids of EVERY changed member (method/field) of
   *  `from` where the reference appears — one edge can touch several methods, so
   *  this is a list. Empty/undefined when no reference sits in a changed member
   *  (or for 'inherits', a class-level relation). */
  fromMembers: z.array(z.string()).optional(),
  /** For 'references': symbol ids of `to`'s members that `from` actually USES —
   *  its constructor (entry) plus any of `to`'s members invoked by name (`.foo`)
   *  in `from`'s body. The downstream end(s) to highlight. */
  toMembers: z.array(z.string()).optional(),
})
export type ClassEdge = z.infer<typeof classEdgeSchema>

export const structuralDiffSchema = z.object({
  scope: structuralScopeSchema,
  taskId: z.string(),
  nodeRunId: z.string().optional(),
  fromRef: z.string(),
  toRef: z.string(),
  engine: engineSchema,
  status: analysisStatusSchema,
  /** e.g. 'indexer-missing' | 'build-failed' | 'timeout' | 'snapshot-pruned'. */
  degradedReason: z.string().optional(),
  files: z.array(fileStructuralDiffSchema).default([]),
  dependencyChanges: z.array(dependencyChangeSchema).default([]),
  /** Non-empty only under deep mode. */
  impact: z.array(impactItemSchema).default([]),
  /** RFC-083 PR-G — class-level relationships among CHANGED classes, for the
   *  graph's hierarchy: 'inherits' (extends/implements) + 'references'
   *  (constructs / holds a field of / statically uses). from/to are
   *  `${filePath}::${qualifiedName}` (= the graph's card ids). */
  classEdges: z.array(classEdgeSchema).default([]),
  summary: structuralDiffSummarySchema,
})
export type StructuralDiff = z.infer<typeof structuralDiffSchema>
