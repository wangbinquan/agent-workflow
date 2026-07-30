// RFC-083 PR-C — git-backed blob readers for a worktree. Enumerates changed
// files between `fromRef` and the live worktree (tracked + untracked), reads the
// old side via `git show <fromRef>:<path>` and the new side from the worktree on
// disk, and hands them to assembleStructuralDiff. After assembly it augments the
// impact with CROSS-FILE callers (worktree-wide `git grep` + re-parse).

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  gitChangedEntries,
  gitChangedEntriesBetween,
  gitGrepFiles,
  readBlobAtRef,
} from '@/util/git'
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
import { MAX_ANALYZE_BYTES } from './baseline'
import type { ImpactItem, StructuralDiff, StructuralScope } from '@agent-workflow/shared'

type BlobReader = (path: string) => Promise<string | null>

/** Cap the candidate caller files we re-parse for cross-file impact (bounds the
 *  cost on large repos; `git grep` already narrows to files that mention a
 *  changed method's name). */
const MAX_CROSS_FILE_CANDIDATES = 60

/** Compute the baseline structural diff between `fromRef` and the current
 *  worktree state. `toRef` is the sentinel 'WORKTREE'. */
export async function computeFromWorktree(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  worktreePath: string
  fromRef: string
}): Promise<StructuralDiff> {
  // RFC-239 — typed enumeration: renames arrive as ONE entry whose old side is
  // read from `oldPath`, so a moved file diffs its real content instead of
  // reporting delete+recreate.
  const changedFiles = await gitChangedEntries(opts.worktreePath, opts.fromRef)
  const readOld = (p: string): Promise<string | null> =>
    readBlobAtRef(opts.worktreePath, opts.fromRef, p)
  const readNew = async (p: string): Promise<string | null> => {
    try {
      return await readFile(join(opts.worktreePath, p), 'utf8')
    } catch {
      return null // deleted in worktree, or unreadable
    }
  }
  const diff = await assembleStructuralDiff({
    taskId: opts.taskId,
    scope: opts.scope,
    nodeRunId: opts.nodeRunId,
    fromRef: opts.fromRef,
    toRef: 'WORKTREE',
    changedFiles,
    readOld,
    readNew,
  })
  const withImpact = await augmentCrossFileImpact(diff, opts.worktreePath, readNew)
  return augmentClassEdges(withImpact, readNew)
}

/** Compute the structural diff between two refs (per-node snapshot pair). Both
 *  sides read via `git show <ref>:<path>`. */
export async function computeBetweenRefs(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  worktreePath: string
  fromRef: string
  toRef: string
}): Promise<StructuralDiff> {
  const changedFiles = await gitChangedEntriesBetween(opts.worktreePath, opts.fromRef, opts.toRef)
  const readOld = (p: string): Promise<string | null> =>
    readBlobAtRef(opts.worktreePath, opts.fromRef, p)
  const readNew = (p: string): Promise<string | null> =>
    readBlobAtRef(opts.worktreePath, opts.toRef, p)
  const diff = await assembleStructuralDiff({
    taskId: opts.taskId,
    scope: opts.scope,
    nodeRunId: opts.nodeRunId,
    fromRef: opts.fromRef,
    toRef: opts.toRef,
    changedFiles,
    readOld,
    readNew,
  })
  // Cross-file callers come from `git grep` against the worktree (the toRef
  // snapshot is a subset of the worktree's tracked content), so the candidate
  // bodies are read via readNew (`git show toRef:path`) for consistency.
  const withImpact = await augmentCrossFileImpact(diff, opts.worktreePath, readNew)
  return augmentClassEdges(withImpact, readNew)
}

/**
 * Extend `diff.impact` with cross-file callers: for each changed method, find
 * other files in the worktree whose code calls it. `git grep` narrows to files
 * mentioning the name; each is re-parsed and its symbols' bodies checked. Merges
 * into the within-file impact already on the diff. Best-effort: any failure for
 * a candidate file is skipped, never throwing.
 */
async function augmentCrossFileImpact(
  diff: StructuralDiff,
  worktreePath: string,
  readNew: BlobReader,
): Promise<StructuralDiff> {
  // Cross-file names are noisier than within-file (no scope), so require ≥3 chars.
  const targets = collectImpactTargets(diff.files, 3)
  if (targets.length === 0) return diff

  const ownerFiles = new Set(targets.map((t) => t.ownerFile))
  const patterns = [...new Set(targets.map((t) => `${t.name}(`))]
  const grepped = await gitGrepFiles(worktreePath, patterns)
  const candidates = grepped
    .filter((p) => !ownerFiles.has(p))
    .filter((p) => {
      const r = resolveLang(p)
      return r !== null && hasExtraction(r.lang)
    })
    .slice(0, MAX_CROSS_FILE_CANDIDATES)
  if (candidates.length === 0) return diff

  // Merge by changedSymbolId so cross-file callers add to within-file ones.
  const impactById = new Map<string, ImpactItem>(
    diff.impact.map((i) => [i.changedSymbolId, { ...i, callers: [...i.callers] }]),
  )

  for (const path of candidates) {
    const resolution = resolveLang(path)
    if (resolution === null) continue
    const text = await readNew(path)
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
  readNew: BlobReader,
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
  for (const file of new Set(nodes.map((n) => n.file))) {
    const text = await readNew(file)
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
