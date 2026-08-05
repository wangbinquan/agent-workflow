// RFC-258 §2.2/§3 — the code-intel resolver behind identifier clicks.
// Dual engine:
//   deep     — SCIP occurrences via the ScipIndexCache (per repo+indexer,
//              gate F-01/F-02/F-15). Precise, cross-file, includes unchanged
//              files. Falls back per-file when the indexer is unavailable or
//              the target document is not covered (F-07).
//   baseline — the task's own extractors: symbols of the clicked file (via
//              file-symbols) plus, for single-repo tasks, the stored
//              structural diff's symbols and its heuristic impact callers
//              (transparently 'inferred' — may miss AND over-report, F-08).
// side='base' always resolves baseline against the base revision (F-05: the
// SCIP index only covers the worktree).

import { extname } from 'node:path'
import {
  parseRepoKeyWire,
  type CodePosition,
  type CodeReference,
  type SymbolResolution,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import type { DbClient } from '@/db/client'
import { getTask } from '@/services/task'
import { getTaskFileSymbols, resolveRepoTarget } from './fileSymbols'
import { worktreeSnapshotDigest } from './snapshot'
import { readStoredDiff } from '@/services/structuralDiff/store'
import { INDEXER_SPECS, type IndexerId } from '@/services/structuralDiff/deep/indexers'
import { occurrencesOf, type ScipGraph } from '@/services/structuralDiff/deep/scip'
import { scipIndexCache, type ScipIndexCache } from '@/services/structuralDiff/deep/indexCache'

export interface CodeIntelQuery {
  path: string
  side: 'base' | 'worktree'
  /** wire repo key ('.' = root); required for multi-repo tasks. */
  repo?: string
  /** 1-based click position. */
  line: number
  col: number
  /** The clicked identifier text (baseline's lookup key; deep's sanity net). */
  name: string
  mode: 'deep' | 'baseline'
}

export interface CodeIntelDeps {
  cache?: ScipIndexCache
}

const REFERENCE_CAP = 500

function indexerForPath(path: string): IndexerId | null {
  const ext = extname(path).toLowerCase()
  for (const spec of Object.values(INDEXER_SPECS)) {
    if (spec.exts.includes(ext)) return spec.id
  }
  return null
}

/** SCIP range [startLine, startChar, (endLine,) endChar] — 0-based, half-open
 *  cols. Returns 1-based positions; null when the range is malformed. */
function scipRangeSpan(
  range: number[],
): { startLine: number; startCol: number; endLine: number; endCol: number } | null {
  if (range.length < 3) return null
  const startLine = (range[0] ?? 0) + 1
  const startCol = (range[1] ?? 0) + 1
  const endLine = (range.length >= 4 ? (range[2] ?? 0) : (range[0] ?? 0)) + 1
  const endCol = (range[range.length - 1] ?? 0) + 1
  return { startLine, startCol, endLine, endCol }
}

function containsPoint(
  span: { startLine: number; startCol: number; endLine: number; endCol: number },
  line: number,
  col: number,
): boolean {
  if (line < span.startLine || line > span.endLine) return false
  if (line === span.startLine && col < span.startCol) return false
  // end col is half-open
  if (line === span.endLine && col >= span.endCol) return false
  return true
}

function spanWidth(span: {
  startLine: number
  startCol: number
  endLine: number
  endCol: number
}): number {
  return (span.endLine - span.startLine) * 10_000 + (span.endCol - span.startCol)
}

export async function getCodeIntel(
  db: DbClient,
  taskId: string,
  q: CodeIntelQuery,
  deps: CodeIntelDeps = {},
): Promise<SymbolResolution> {
  if (q.path === '' || q.name === '' || q.line < 1 || q.col < 1) {
    throw new ValidationError(
      'code-intel-missing-params',
      'path, name and 1-based line/col query params are required',
    )
  }
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const { worktreePath } = resolveRepoTarget(task, q.repo)
  const repoKey = task.repoCount > 1 ? parseRepoKeyWire(q.repo ?? '') : ''

  if (q.mode === 'deep' && q.side === 'worktree') {
    const indexerId = indexerForPath(q.path)
    if (indexerId === null) {
      return baseline(db, task.id, task.repoCount, repoKey, q, 'deep', 'no-indexer-for-language')
    }
    const cache = deps.cache ?? scipIndexCache()
    const snapshotDigest = await worktreeSnapshotDigest(worktreePath)
    const answer = await cache.get({
      taskId: task.id,
      repoKey,
      snapshotDigest,
      indexerId,
      worktreePath,
    })
    if (!answer.ok) {
      return baseline(db, task.id, task.repoCount, repoKey, q, 'deep', answer.reason)
    }
    const doc = answer.graph.documents.find((d) => d.relativePath === q.path)
    if (doc === undefined) {
      return baseline(db, task.id, task.repoCount, repoKey, q, 'deep', 'document-not-indexed')
    }
    return deepResolve(answer.graph, doc.relativePath, repoKey, q)
  }

  const degraded = q.mode === 'deep' && q.side === 'base' ? 'base-side-not-indexed' : undefined
  return baseline(db, task.id, task.repoCount, repoKey, q, q.mode, degraded)
}

function deepResolve(
  graph: ScipGraph,
  docPath: string,
  repoKey: string,
  q: CodeIntelQuery,
): SymbolResolution {
  const doc = graph.documents.find((d) => d.relativePath === docPath)
  let best: { symbol: string; width: number } | null = null
  for (const occ of doc?.occurrences ?? []) {
    const span = scipRangeSpan(occ.range)
    if (span === null || !containsPoint(span, q.line, q.col)) continue
    const width = spanWidth(span)
    if (best === null || width < best.width) best = { symbol: occ.symbol, width }
  }
  if (best === null) {
    // The document IS indexed — an occurrence miss is a precise empty result
    // (comment/string/whitespace), not a degradation (F-07).
    return {
      requestedEngine: 'deep',
      engine: 'deep',
      symbol: q.name,
      definitions: [],
      references: [],
    }
  }
  const occs = occurrencesOf(graph, best.symbol, docPath)
  const definitions: CodePosition[] = []
  const references: CodeReference[] = []
  for (const { doc: occDoc, occ } of occs) {
    const span = scipRangeSpan(occ.range)
    if (span === null) continue
    const pos: CodePosition = {
      repoKey,
      filePath: occDoc,
      side: 'worktree',
      startLine: span.startLine,
      startCol: span.startCol,
      endLine: span.endLine,
    }
    if (occ.isDefinition) definitions.push(pos)
    else if (references.length < REFERENCE_CAP) references.push({ ...pos, confidence: 'extracted' })
  }
  const truncated = occs.filter(({ occ }) => !occ.isDefinition).length > REFERENCE_CAP
  return {
    requestedEngine: 'deep',
    engine: 'deep',
    symbol: best.symbol,
    definitions,
    references,
    ...(truncated ? { truncated: true } : {}),
  }
}

async function baseline(
  db: DbClient,
  taskId: string,
  repoCount: number,
  repoKey: string,
  q: CodeIntelQuery,
  requestedEngine: 'deep' | 'baseline',
  degradedReason: string | undefined,
): Promise<SymbolResolution> {
  const definitions: CodePosition[] = []
  const references: CodeReference[] = []
  const seenDef = new Set<string>()

  // Source 1 — the clicked file's own symbol table (both sides supported).
  try {
    const fileSyms = await getTaskFileSymbols(db, taskId, {
      path: q.path,
      side: q.side,
      ...(q.repo !== undefined ? { repo: q.repo } : {}),
    })
    for (const s of fileSyms.symbols) {
      if (s.name !== q.name) continue
      const key = `${q.path} ${s.range.startLine}`
      if (seenDef.has(key)) continue
      seenDef.add(key)
      definitions.push({
        repoKey,
        filePath: q.path,
        side: q.side,
        startLine: s.range.startLine,
        endLine: s.range.endLine,
      })
    }
  } catch {
    // unreadable clicked file — the other sources may still answer
  }

  // Sources 2+3 — the stored structural diff's symbols + heuristic impact.
  // Single-repo only: the stored artifact's file paths carry display labels in
  // multi-repo tasks and MUST NOT be prefix-guessed back to repos (F-04).
  let multiRepoLimited = false
  if (repoCount <= 1) {
    const stored = await readStoredDiff(taskId, 'task')
    if (stored !== null) {
      for (const f of stored.files) {
        for (const ch of f.changes) {
          const node = q.side === 'base' ? (ch.before ?? null) : (ch.after ?? null)
          if (node === null || node.name !== q.name || node.range === undefined) continue
          const key = `${node.filePath} ${node.range.startLine}`
          if (seenDef.has(key)) continue
          seenDef.add(key)
          definitions.push({
            repoKey,
            filePath: node.filePath,
            side: q.side,
            startLine: node.range.startLine,
            endLine: node.range.endLine,
          })
        }
      }
      if (q.side === 'worktree') {
        for (const item of stored.impact) {
          const leaf = item.changedSymbolId.split('#')[1]?.split(':')[0]?.split('.').pop()
          if (leaf !== q.name) continue
          for (const caller of item.callers) {
            if (references.length >= REFERENCE_CAP) break
            references.push({
              repoKey,
              filePath: caller.filePath,
              side: 'worktree',
              startLine: caller.range.startLine,
              endLine: caller.range.endLine,
              confidence: item.confidence === 'extracted' ? 'extracted' : 'inferred',
            })
          }
        }
      }
    }
  } else {
    multiRepoLimited = true
  }

  const reason = degradedReason ?? (multiRepoLimited ? 'multi-repo-baseline-limited' : undefined)
  return {
    requestedEngine,
    engine: 'baseline',
    ...(reason !== undefined ? { degradedReason: reason } : {}),
    symbol: q.name,
    definitions,
    references,
  }
}
