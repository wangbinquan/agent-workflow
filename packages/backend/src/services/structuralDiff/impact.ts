// RFC-083 — within-file blast radius (the static, CI-verifiable slice of the
// "impact" pillar). For each changed method, find the OTHER methods in the same
// (new) file whose body calls it. Heuristic: a `name(` text match inside another
// method's source range — no cross-file resolution, no type info — so callers
// are tagged confidence 'inferred'. Precise cross-file impact (the SCIP deep
// mode) is a documented follow-up; this delivers the common same-file/class
// "who calls this" signal without any external indexer.

import type { ImpactItem, SymbolChange, SymbolNode, SymbolKind } from '@agent-workflow/shared'

const CALLABLE: ReadonlySet<SymbolKind> = new Set<SymbolKind>(['method', 'function', 'constructor'])

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  const bodyOf = (s: SymbolNode): string =>
    s.range !== undefined ? lines.slice(s.range.startLine - 1, s.range.endLine).join('\n') : ''

  const out: ImpactItem[] = []
  const seenName = new Set<string>()
  for (const ch of changes) {
    if (
      ch.changeType !== 'modified' &&
      ch.changeType !== 'removed' &&
      ch.changeType !== 'renamed'
    ) {
      continue
    }
    const target = ch.after ?? ch.before
    if (target === undefined || !CALLABLE.has(target.kind)) continue
    const name = target.name
    if (name.length < 2 || seenName.has(name)) continue
    seenName.add(name)

    const re = new RegExp(`\\b${escapeRegExp(name)}\\s*\\(`)
    const callers: ImpactItem['callers'] = []
    for (const s of newSymbols) {
      if (!CALLABLE.has(s.kind)) continue
      if (s.qualifiedName === target.qualifiedName) continue // not itself
      if (re.test(bodyOf(s))) {
        callers.push({
          symbolId: s.id,
          filePath,
          range: s.range ?? { startLine: 0, endLine: 0 },
        })
      }
    }
    if (callers.length > 0) {
      out.push({ changedSymbolId: target.id, callers, confidence: 'inferred' })
    }
  }
  return out
}
