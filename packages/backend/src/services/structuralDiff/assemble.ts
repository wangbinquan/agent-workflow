// RFC-083 PR-C — assemble a full StructuralDiff from a changed-file list + a
// pair of blob readers (old/new). I/O is injected (readOld/readNew), so the
// assembly is unit-testable with in-memory readers and the git-backed wiring
// (gitBackend.ts) stays thin.
//
// Per file: code files → analyzeFile (tree-sitter symbol diff); manifest files →
// dependency set-diff. computeSummary aggregates both for the summary cards.

import {
  computeSummary,
  type StructuralDiff,
  type FileStructuralDiff,
  type DependencyChange,
  type StructuralScope,
  type Engine,
  type AnalysisStatus,
  type ClassEdge,
  type ImpactItem,
  type SymbolNode,
  type SymbolChange,
} from '@agent-workflow/shared'
import { analyzeFile } from './baseline'
import { resolveLang } from './lang/grammars'
import { aggregateDependencyChanges } from './deps/diff'
import { ecosystemForManifest } from './deps/manifests'

export type BlobReader = (path: string) => Promise<string | null>

export async function assembleStructuralDiff(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  fromRef: string
  toRef: string
  changedFiles: string[]
  readOld: BlobReader
  readNew: BlobReader
  engine?: Engine
  status?: AnalysisStatus
  degradedReason?: string
}): Promise<StructuralDiff> {
  const files: FileStructuralDiff[] = []
  const manifestInputs: Array<{
    filePath: string
    oldContent: string | null
    newContent: string | null
  }> = []

  for (const path of opts.changedFiles) {
    const isCode = resolveLang(path) !== null
    const isManifest = ecosystemForManifest(path) !== null
    if (!isCode && !isManifest) continue
    const [oldText, newText] = await Promise.all([opts.readOld(path), opts.readNew(path)])
    if (isCode) {
      files.push(await analyzeFile({ filePath: path, oldText, newText }))
    }
    if (isManifest) {
      manifestInputs.push({ filePath: path, oldContent: oldText, newContent: newText })
    }
  }

  const dependencyChanges = applyViaImport(files, aggregateDependencyChanges(manifestInputs))
  const summary = computeSummary(files, dependencyChanges)
  // RFC-085 — a chain root must be a CHANGED callable still present (`after`).
  const callChainAvailable = files.some((f) =>
    f.changes.some(
      (ch) =>
        ch.after !== undefined &&
        (ch.kind === 'method' || ch.kind === 'function' || ch.kind === 'constructor'),
    ),
  )

  return {
    scope: opts.scope,
    taskId: opts.taskId,
    nodeRunId: opts.nodeRunId,
    fromRef: opts.fromRef,
    toRef: opts.toRef,
    engine: opts.engine ?? 'baseline',
    status: opts.status ?? 'ok',
    degradedReason: opts.degradedReason,
    files,
    dependencyChanges,
    impact: files.flatMap((f) => f.impact),
    classEdges: [], // filled by the git backend (needs file content)
    callChainAvailable,
    summary,
  }
}

/**
 * RFC-083 — correlate added/updated manifest deps with new source imports
 * (US-4: "a new import resolving to a newly-added package is the highest-
 * confidence 'this change adds a dependency on X'"). Heuristic substring match
 * (the import-path→package mapping is fuzzy across ecosystems); a hint, not an
 * authority. For `group:artifact` deps (maven/gradle/sbt) the artifact segment
 * is also tried.
 */
function applyViaImport(files: FileStructuralDiff[], deps: DependencyChange[]): DependencyChange[] {
  const addedImports: string[] = []
  for (const f of files) {
    for (const c of f.changes) {
      if (c.kind !== 'import' || c.changeType !== 'added') continue
      const token = (c.after?.qualifiedName ?? c.after?.name ?? '').toLowerCase()
      if (token !== '') addedImports.push(token)
    }
  }
  if (addedImports.length === 0) return deps
  return deps.map((d) => {
    if (d.changeType === 'removed') return d
    const candidates = [d.packageName.toLowerCase()]
    if (d.packageName.includes(':')) {
      const artifact = d.packageName.split(':').pop()
      if (artifact !== undefined) candidates.push(artifact.toLowerCase())
    }
    const hit = candidates.some((c) => c.length >= 3 && addedImports.some((imp) => imp.includes(c)))
    return hit ? { ...d, viaImport: true } : d
  })
}

// ---------------------------------------------------------------------------
// RFC-089 P2 — multi-repo id namespacing.
//
// The class graph builds each card's id from a SYMBOL's own filePath
// (`${sym.filePath}::${qn}`, see frontend structureGraph.ts), and `classEdges`
// reference those same `${filePath}::${qn}` card ids; symbol ids are
// `${filePath}#${qn}:${kind}`. So to merge per-repo diffs into one consistent
// namespace, EVERY embedded filePath — file paths, symbol ids/parentIds, edge
// endpoints, impact refs, classEdge endpoints/members — must get the SAME
// `${label}/` prefix, or the graph's cards and edges won't line up (and
// same-path files across repos collide). The pre-RFC-089 merge prefixed only
// `file.filePath`, which is exactly why `classEdges` had to be dropped.
// ---------------------------------------------------------------------------

const prefixPath = (label: string, fp: string): string => `${label}/${fp}`

/** Prefix the leading filePath segment of an id delimited by `delim` — symbol
 *  id `${filePath}#…` (delim `#`) or card id `${filePath}::…` (delim `::`). A
 *  bare path with no delimiter is prefixed whole. Exported for unit tests. */
export function prefixIdPath(label: string, id: string, delim: string): string {
  const i = id.indexOf(delim)
  return i < 0 ? prefixPath(label, id) : prefixPath(label, id.slice(0, i)) + id.slice(i)
}
const prefixSymbolId = (label: string, id: string): string => prefixIdPath(label, id, '#')
const prefixCardId = (label: string, id: string): string => prefixIdPath(label, id, '::')

function prefixSymbolNode(label: string, s: SymbolNode): SymbolNode {
  return {
    ...s,
    id: prefixSymbolId(label, s.id),
    filePath: prefixPath(label, s.filePath),
    parentId: s.parentId !== undefined ? prefixSymbolId(label, s.parentId) : undefined,
  }
}

function prefixChange(label: string, c: SymbolChange): SymbolChange {
  return {
    ...c,
    before: c.before !== undefined ? prefixSymbolNode(label, c.before) : undefined,
    after: c.after !== undefined ? prefixSymbolNode(label, c.after) : undefined,
    hunkAnchor:
      c.hunkAnchor !== undefined
        ? { ...c.hunkAnchor, filePath: prefixPath(label, c.hunkAnchor.filePath) }
        : undefined,
  }
}

function prefixImpactItem(label: string, it: ImpactItem): ImpactItem {
  return {
    ...it,
    changedSymbolId: prefixSymbolId(label, it.changedSymbolId),
    callers: it.callers.map((c) => ({
      ...c,
      symbolId: c.symbolId !== undefined ? prefixSymbolId(label, c.symbolId) : undefined,
      filePath: prefixPath(label, c.filePath),
    })),
  }
}

function prefixFile(label: string, f: FileStructuralDiff): FileStructuralDiff {
  return {
    ...f,
    filePath: prefixPath(label, f.filePath),
    changes: f.changes.map((c) => prefixChange(label, c)),
    edges: f.edges.map((e) => ({
      ...e,
      from: prefixSymbolId(label, e.from),
      to: prefixSymbolId(label, e.to),
    })),
    impact: f.impact.map((it) => prefixImpactItem(label, it)),
  }
}

function prefixClassEdge(label: string, e: ClassEdge): ClassEdge {
  return {
    ...e,
    from: prefixCardId(label, e.from),
    to: prefixCardId(label, e.to),
    fromMembers:
      e.fromMembers !== undefined ? e.fromMembers.map((m) => prefixSymbolId(label, m)) : undefined,
    toMembers:
      e.toMembers !== undefined ? e.toMembers.map((m) => prefixSymbolId(label, m)) : undefined,
  }
}

/** Merge several per-repo StructuralDiffs (multi-repo task) into one. Every
 *  embedded filePath/id is `${label}/`-prefixed so the merged set is ONE
 *  consistent namespace — file tree, class graph (RFC-089 P2) and impact
 *  cross-nav all line up, and same-path files across repos never collide.
 *  Recomputes the summary over the merged set. */
export function mergeStructuralDiffs(
  base: Omit<StructuralDiff, 'files' | 'dependencyChanges' | 'summary' | 'impact' | 'classEdges'>,
  parts: Array<{ label: string; diff: StructuralDiff }>,
): StructuralDiff {
  const files: FileStructuralDiff[] = []
  const dependencyChanges: DependencyChange[] = []
  const classEdges: ClassEdge[] = []
  for (const { label, diff } of parts) {
    for (const f of diff.files) files.push(prefixFile(label, f))
    for (const d of diff.dependencyChanges) {
      dependencyChanges.push({
        ...d,
        manifestPath: d.manifestPath !== undefined ? prefixPath(label, d.manifestPath) : undefined,
      })
    }
    for (const e of diff.classEdges) classEdges.push(prefixClassEdge(label, e))
  }
  return {
    ...base,
    files,
    dependencyChanges,
    impact: files.flatMap((f) => f.impact),
    classEdges,
    summary: computeSummary(files, dependencyChanges),
  }
}
