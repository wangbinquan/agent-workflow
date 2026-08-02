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

/** A changed file: bare path, or `{ path, oldPath }` when git detected a rename
 *  (RFC-239) — the old side is then read from `oldPath` and the produced
 *  FileStructuralDiff carries `renamedFrom`, so symbol diffs compare real
 *  old/new content instead of reporting delete+recreate. */
export type ChangedFileInput = string | { path: string; oldPath?: string }

export async function assembleStructuralDiff(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  fromRef: string
  toRef: string
  changedFiles: ChangedFileInput[]
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

  for (const input of opts.changedFiles) {
    const path = typeof input === 'string' ? input : input.path
    const oldPath = typeof input === 'string' ? undefined : input.oldPath
    const isCode = resolveLang(path) !== null
    const isManifest = ecosystemForManifest(path) !== null
    if (!isCode && !isManifest) continue
    const [oldText, newText] = await Promise.all([
      opts.readOld(oldPath ?? path),
      opts.readNew(path),
    ])
    if (isCode) {
      const analyzed = await analyzeFile({ filePath: path, oldText, newText })
      files.push(oldPath === undefined ? analyzed : { ...analyzed, renamedFrom: oldPath })
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

/**
 * RFC-248 设计门一轮 G3 —— **空 label 原样返回**。
 *
 * 现状不变量是「加前缀 ⟺ 多仓」：单仓走 `structuralDiff/service.ts:95-118` 的
 * 早分支、完全不加前缀（`src/a.ts`），与文本 diff 单仓无分段头的形态一致。
 * 仓库组引入「挂根成员」后，它的规范 key 是空串——无条件拼 `${label}/` 会产出
 * `/src/a.ts`，而文本 diff 那边是 `src/a.ts`；前端 `lib/changeReview.ts` 靠路径
 * 逐字符相等 join 两侧，于是根仓的符号 / 严重度 / 文件内容 / 导航会**静默脱节**。
 *
 * 改这一处即可覆盖下方注释列出的全部 7 类嵌入路径——它们都经由本函数与
 * `prefixIdPath`。
 */
const prefixPath = (label: string, fp: string): string => (label === '' ? fp : `${label}/${fp}`)

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
    // RFC-248 H8: 归属**显式**落在字段上，不让下游从路径最长前缀反推。
    // 字符串前缀仍然保留（展示与文本 diff join 靠它），但判定不再依赖它。
    repoKey: label,
    filePath: prefixPath(label, f.filePath),
    renamedFrom: f.renamedFrom !== undefined ? prefixPath(label, f.renamedFrom) : undefined,
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
    // RFC-089 P4 — the ⎇ call-chain entry lights up if ANY repo has a chain root.
    // Safe to expose for multi-repo now that getCallTargets resolves per repo.
    callChainAvailable: parts.some((p) => p.diff.callChainAvailable === true),
    summary: computeSummary(files, dependencyChanges),
  }
}
