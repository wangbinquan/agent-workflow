// RFC-083 — blast radius ("who calls a changed method"). Two layers, both
// zero-dependency + CI-verifiable:
//   - within-file (computeWithinFileImpact): callers in the same file.
//   - cross-file (augmentCrossFileImpact in gitBackend): callers elsewhere in
//     the worktree, found via `git grep` + re-parsing the candidate files.
// Both are heuristic — a `name(` text match, no type resolution — so callers
// are tagged confidence 'inferred'. Precise, type-resolved cross-file impact
// (the optional SCIP deep mode) eliminates the heuristic's false positives and
// is the documented in-RFC enhancement; it needs an external indexer, so it
// can't run in CI, but the CAPABILITY (cross-file blast radius) is delivered
// here without it.

import type {
  ImpactItem,
  ImpactCaller,
  SymbolChange,
  SymbolNode,
  SymbolKind,
} from '@agent-workflow/shared'

export const CALLABLE: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'function',
  'constructor',
])

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function bodyText(s: SymbolNode, lines: string[]): string {
  return s.range !== undefined ? lines.slice(s.range.startLine - 1, s.range.endLine).join('\n') : ''
}

/** Symbols in this file whose body calls `name(`, excluding the definition
 *  itself (by qualifiedName). */
export function findCallers(
  name: string,
  symbols: readonly SymbolNode[],
  lines: string[],
  filePath: string,
  excludeQualifiedName?: string,
): ImpactCaller[] {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`)
  const callers: ImpactCaller[] = []
  for (const s of symbols) {
    if (!CALLABLE.has(s.kind)) continue
    if (excludeQualifiedName !== undefined && s.qualifiedName === excludeQualifiedName) continue
    if (re.test(bodyText(s, lines))) {
      callers.push({ symbolId: s.id, filePath, range: s.range ?? { startLine: 0, endLine: 0 } })
    }
  }
  return callers
}

function isImpactRelevant(ch: SymbolChange): boolean {
  // Every changed callable — INCLUDING 'added' — gets its callers found, so the
  // graph shows call relationships among new classes too (A(new) → B(new)), not
  // just the blast radius of edits. 'added' was previously excluded, which left
  // new-class call edges invisible.
  return (
    ch.changeType === 'added' ||
    ch.changeType === 'modified' ||
    ch.changeType === 'removed' ||
    ch.changeType === 'renamed' ||
    ch.changeType === 'moved'
  )
}

export interface ImpactTarget {
  changedSymbolId: string
  name: string
  qualifiedName: string
  ownerFile: string
}

/** The changed callable symbols worth computing impact for (ALL change types,
 *  incl. added — so callers/uses of new methods are found too; names ≥ minLen).
 *  Dedups by id. */
export function collectImpactTargets(
  files: ReadonlyArray<{ filePath: string; changes: readonly SymbolChange[] }>,
  minNameLen = 2,
): ImpactTarget[] {
  const out: ImpactTarget[] = []
  const seen = new Set<string>()
  for (const f of files) {
    for (const ch of f.changes) {
      if (!isImpactRelevant(ch)) continue
      const node = ch.after ?? ch.before
      if (node === undefined || !CALLABLE.has(node.kind)) continue
      if (node.name.length < minNameLen || seen.has(node.id)) continue
      seen.add(node.id)
      out.push({
        changedSymbolId: node.id,
        name: node.name,
        qualifiedName: node.qualifiedName,
        ownerFile: f.filePath,
      })
    }
  }
  return out
}

/** Within-file callers of each changed method, from the NEW file's symbols. */
export function computeWithinFileImpact(
  changes: readonly SymbolChange[],
  newSymbols: readonly SymbolNode[],
  newText: string | null,
  filePath: string,
): ImpactItem[] {
  if (newText === null || newSymbols.length === 0) return []
  const lines = newText.split('\n')
  const out: ImpactItem[] = []
  const seenName = new Set<string>()
  for (const target of collectImpactTargets([{ filePath, changes }])) {
    if (seenName.has(target.name)) continue
    seenName.add(target.name)
    const callers = findCallers(target.name, newSymbols, lines, filePath, target.qualifiedName)
    if (callers.length > 0) {
      out.push({ changedSymbolId: target.changedSymbolId, callers, confidence: 'inferred' })
    }
  }
  return out
}
