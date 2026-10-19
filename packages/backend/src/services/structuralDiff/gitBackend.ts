// RFC-083 PR-C — revision-backed blob readers for a worktree. Enumerates changed
// files between `fromRef` and the live worktree (tracked + untracked), reads the
// old side at `fromRef` and the new side from the worktree, and hands them to
// assembleStructuralDiff. After assembly it augments the impact with CROSS-FILE
// callers (worktree-wide grep + re-parse).
//
// RFC-370 §10 V16 — every read goes through the selected revision content
// (`RepositoryRevisionContent`): the native worktree on this host, or the task
// volume of a hosted task. Each side is read once per computation and in
// batches, so a hosted volume answers a whole diff in a few commands.

import {
  composeLocalRepositoryRevisionContent,
  type RepositoryRevisionContent,
  type RevisionChangeEntry,
  type RevisionFileRead,
  type WorktreeFileRead,
} from '@/modules/source-control/public/participants'
import { assembleStructuralDiff } from './assemble'
import { resolveLang } from './lang/grammars'
import { hasExtraction } from './lang/queries'
import { extractSymbols } from './lang/extract'
import { maskCommentsAndStrings } from './lang/mask'
import { collectImpactTargets, findCallers } from './impact'
import {
  collectClassNodes,
  collectClassMembers,
  computeClassEdges,
  computeAnonCreationEdges,
} from './classGraph'
import { ecosystemForManifest } from './deps/manifests'
import { MAX_ANALYZE_BYTES, blobText, type AnalysisBlob } from './baseline'
import type { ImpactItem, StructuralDiff, StructuralScope } from '@agent-workflow/shared'

/** Cap the candidate caller files we re-parse for cross-file impact (bounds the
 *  cost on large repos; the grep already narrows to files that mention a
 *  changed method's name). */
const MAX_CROSS_FILE_CANDIDATES = 60

/** RFC-370 §10 V16 — the read bound of an analyzed side. Every text the
 *  analyzer analyzes (at most MAX_ANALYZE_BYTES characters, at most three UTF-8
 *  bytes each) still arrives as text; a larger side arrives as `oversized` and
 *  classifies the file exactly as its text would have. */
export const ANALYZE_READ_MAX_BYTES = MAX_ANALYZE_BYTES * 3

/** Worktree files read at once (a hosted read is one platform file request). */
const WORKTREE_READ_CONCURRENCY = 8

function analysisBlob(read: RevisionFileRead | WorktreeFileRead): AnalysisBlob {
  switch (read.kind) {
    case 'text':
      return read.content
    case 'absent':
    case 'outside':
      return null
    case 'oversized':
    case 'binary':
      return { unreadable: read.kind }
  }
}

/** One side of one computation: each path is read once, in batches. */
interface SideReader {
  prefetch(paths: readonly string[]): Promise<void>
  read(path: string): Promise<AnalysisBlob>
}

function sideReader(
  fetch: (paths: readonly string[]) => Promise<ReadonlyMap<string, AnalysisBlob>>,
): SideReader {
  const cache = new Map<string, AnalysisBlob>()
  const prefetch = async (paths: readonly string[]): Promise<void> => {
    const missing = [...new Set(paths)].filter((path) => !cache.has(path))
    if (missing.length === 0) return
    const read = await fetch(missing)
    for (const path of missing) cache.set(path, read.get(path) ?? null)
  }
  return {
    prefetch,
    async read(path) {
      await prefetch([path])
      return cache.get(path) ?? null
    },
  }
}

function revisionSide(content: RepositoryRevisionContent, rev: string): SideReader {
  return sideReader(async (paths) => {
    const reads = await content.readRevision({ rev, paths, maxBytes: ANALYZE_READ_MAX_BYTES })
    return new Map(paths.map((path) => [path, analysisBlob(reads.get(path) ?? { kind: 'absent' })]))
  })
}

function worktreeSide(content: RepositoryRevisionContent): SideReader {
  return sideReader(async (paths) => {
    const reads = new Map<string, AnalysisBlob>()
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const path = paths[next++]!
        reads.set(
          path,
          analysisBlob(await content.readWorktree({ path, maxBytes: ANALYZE_READ_MAX_BYTES })),
        )
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(WORKTREE_READ_CONCURRENCY, paths.length) }, worker),
    )
    return reads
  })
}

/** The files assembleStructuralDiff reads: code and dependency manifests. */
async function prefetchAnalyzed(
  changed: readonly RevisionChangeEntry[],
  oldSide: SideReader,
  newSide: SideReader,
): Promise<void> {
  const files = changed.filter(
    (entry) => resolveLang(entry.path) !== null || ecosystemForManifest(entry.path) !== null,
  )
  await Promise.all([
    oldSide.prefetch(files.map((entry) => entry.oldPath ?? entry.path)),
    newSide.prefetch(files.map((entry) => entry.path)),
  ])
}

function contentOf(opts: {
  readonly worktreePath: string
  readonly content?: RepositoryRevisionContent
}): RepositoryRevisionContent {
  return opts.content ?? composeLocalRepositoryRevisionContent().bind(opts.worktreePath)
}

/** Compute the baseline structural diff between `fromRef` and the current
 *  worktree state. `toRef` is the sentinel 'WORKTREE'. */
export async function computeFromWorktree(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  worktreePath: string
  fromRef: string
  /** RFC-370 §10 V16 — the selected content; the native worktree when absent. */
  content?: RepositoryRevisionContent
}): Promise<StructuralDiff> {
  const content = contentOf(opts)
  // RFC-239 — typed enumeration: renames arrive as ONE entry whose old side is
  // read from `oldPath`, so a moved file diffs its real content instead of
  // reporting delete+recreate.
  const changedFiles = (await content.changes({ from: opts.fromRef })).entries
  const oldSide = revisionSide(content, opts.fromRef)
  const newSide = worktreeSide(content)
  await prefetchAnalyzed(changedFiles, oldSide, newSide)
  const diff = await assembleStructuralDiff({
    taskId: opts.taskId,
    scope: opts.scope,
    nodeRunId: opts.nodeRunId,
    fromRef: opts.fromRef,
    toRef: 'WORKTREE',
    changedFiles: [...changedFiles],
    readOld: oldSide.read,
    readNew: newSide.read,
  })
  const withImpact = await augmentCrossFileImpact(diff, content, newSide)
  return augmentClassEdges(withImpact, newSide)
}

/** Compute the structural diff between two refs (per-node snapshot pair). Both
 *  sides are read at their revision. */
export async function computeBetweenRefs(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  worktreePath: string
  fromRef: string
  toRef: string
  /** RFC-370 §10 V16 — the selected content; the native worktree when absent. */
  content?: RepositoryRevisionContent
}): Promise<StructuralDiff> {
  const content = contentOf(opts)
  const changedFiles = (await content.changes({ from: opts.fromRef, to: opts.toRef })).entries
  const oldSide = revisionSide(content, opts.fromRef)
  const newSide = revisionSide(content, opts.toRef)
  await prefetchAnalyzed(changedFiles, oldSide, newSide)
  const diff = await assembleStructuralDiff({
    taskId: opts.taskId,
    scope: opts.scope,
    nodeRunId: opts.nodeRunId,
    fromRef: opts.fromRef,
    toRef: opts.toRef,
    changedFiles: [...changedFiles],
    readOld: oldSide.read,
    readNew: newSide.read,
  })
  // Cross-file callers come from the worktree grep (the toRef snapshot is a
  // subset of the worktree's tracked content), so the candidate bodies are read
  // at toRef for consistency.
  const withImpact = await augmentCrossFileImpact(diff, content, newSide)
  return augmentClassEdges(withImpact, newSide)
}

/**
 * Extend `diff.impact` with cross-file callers: for each changed method, find
 * other files in the worktree whose code calls it. The grep narrows to files
 * mentioning the name; each is re-parsed and its symbols' bodies checked. Merges
 * into the within-file impact already on the diff. Best-effort: any failure for
 * a candidate file is skipped, never throwing.
 */
async function augmentCrossFileImpact(
  diff: StructuralDiff,
  content: RepositoryRevisionContent,
  newSide: SideReader,
): Promise<StructuralDiff> {
  // Cross-file names are noisier than within-file (no scope), so require ≥3 chars.
  const targets = collectImpactTargets(diff.files, 3)
  if (targets.length === 0) return diff

  const ownerFiles = new Set(targets.map((t) => t.ownerFile))
  const patterns = [...new Set(targets.map((t) => `${t.name}(`))]
  const grepped = await content.grep(patterns)
  const candidates = grepped
    .filter((p) => !ownerFiles.has(p))
    .filter((p) => {
      const r = resolveLang(p)
      return r !== null && hasExtraction(r.lang)
    })
    .slice(0, MAX_CROSS_FILE_CANDIDATES)
  if (candidates.length === 0) return diff
  await newSide.prefetch(candidates)

  // Merge by changedSymbolId so cross-file callers add to within-file ones.
  const impactById = new Map<string, ImpactItem>(
    diff.impact.map((i) => [i.changedSymbolId, { ...i, callers: [...i.callers] }]),
  )

  for (const path of candidates) {
    const resolution = resolveLang(path)
    if (resolution === null) continue
    const text = blobText(await newSide.read(path))
    if (text === null || text.length > MAX_ANALYZE_BYTES) continue
    let symbols
    try {
      symbols = (
        await extractSymbols({
          lang: resolution.lang,
          grammarFile: resolution.grammarFile,
          filePath: path,
          source: text,
        })
      ).symbols
    } catch {
      continue
    }
    const lines = text.split('\n')
    for (const target of targets) {
      const callers = findCallers(target.name, symbols, lines, path) // different file → no self-exclude
      if (callers.length === 0) continue
      let item = impactById.get(target.changedSymbolId)
      if (item === undefined) {
        item = { changedSymbolId: target.changedSymbolId, callers: [], confidence: 'inferred' }
        impactById.set(target.changedSymbolId, item)
      }
      item.callers.push(...callers)
    }
  }

  return { ...diff, impact: [...impactById.values()] }
}

/**
 * Compute class-level inherit/reference edges (RFC-083 PR-G) by reading each
 * changed class's NEW file content and matching other changed class names.
 * Best-effort: an unreadable file is skipped.
 */
async function augmentClassEdges(
  diff: StructuralDiff,
  newSide: SideReader,
): Promise<StructuralDiff> {
  // RFC-086 — anon "created by" edges come from the parentId chain (no file read);
  // emit them even when there are too few class nodes for the name-match pass.
  const anonEdges = computeAnonCreationEdges(diff.files)
  const nodes = collectClassNodes(diff.files)
  if (nodes.length < 2) {
    return anonEdges.length > 0 ? { ...diff, classEdges: anonEdges } : diff
  }
  // RFC-087 — mask comments + string literals via the AST (per-language), so a
  // class/method name mentioned only in a comment/string isn't matched as a real
  // reference. Replaces the C-family hand lexer for the production path; the
  // regex stripper inside computeClassEdges then no-ops on the masked text.
  const fileText = new Map<string, string>()
  const files = [...new Set(nodes.map((n) => n.file))]
  await newSide.prefetch(files)
  for (const file of files) {
    const text = blobText(await newSide.read(file))
    if (text === null || text.length > MAX_ANALYZE_BYTES) continue
    const r = resolveLang(file)
    fileText.set(
      file,
      r !== null ? await maskCommentsAndStrings(r.lang, r.grammarFile, text) : text,
    )
  }
  const membersByClass = collectClassMembers(diff.files)
  const nameEdges = computeClassEdges(nodes, fileText, membersByClass)
  const seen = new Set(nameEdges.map((e) => `${e.from}|${e.to}|${e.kind}`))
  const merged = [
    ...nameEdges,
    ...anonEdges.filter((e) => !seen.has(`${e.from}|${e.to}|${e.kind}`)),
  ]
  return { ...diff, classEdges: merged }
}
