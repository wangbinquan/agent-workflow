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

/** Merge several per-repo StructuralDiffs (multi-repo task) into one, prefixing
 *  file paths with the repo label so the UI can tell them apart. Recomputes the
 *  summary over the merged set. */
export function mergeStructuralDiffs(
  base: Omit<StructuralDiff, 'files' | 'dependencyChanges' | 'summary' | 'impact'>,
  parts: Array<{ label: string; diff: StructuralDiff }>,
): StructuralDiff {
  const files: FileStructuralDiff[] = []
  const dependencyChanges = []
  for (const { label, diff } of parts) {
    for (const f of diff.files) files.push({ ...f, filePath: `${label}/${f.filePath}` })
    for (const d of diff.dependencyChanges) {
      dependencyChanges.push({
        ...d,
        manifestPath: d.manifestPath !== undefined ? `${label}/${d.manifestPath}` : undefined,
      })
    }
  }
  return {
    ...base,
    files,
    dependencyChanges,
    impact: files.flatMap((f) => f.impact),
    summary: computeSummary(files, dependencyChanges),
  }
}
