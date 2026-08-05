// RFC-083 PR-E — precise reverse-reference impact (PURE). The heart of deep
// mode: where the baseline uses a `name(` text heuristic (confidence 'inferred',
// can't tell two same-named methods apart), this uses the indexer's resolved
// SCIP symbols (confidence 'extracted').
//
// Mapping baseline → SCIP is POSITIONAL: a baseline-changed method carries
// {ownerFile, range}; we find the Definition occurrence at that position and take
// its SCIP symbol, then fan out to every NON-definition occurrence of that exact
// symbol across documents = the precise callers.

import type { FileStructuralDiff, ImpactItem, ImpactCaller } from '@agent-workflow/shared'
import { occurrencesOf, type ScipGraph } from './scip'
import { CALLABLE } from '../impact'

/** SCIP ranges are 0-based [startLine, startChar, (endLine,) endChar]; our
 *  schema ranges are 1-based {startLine, endLine}. */
function scipRangeToSource(range: number[]): { startLine: number; endLine: number } {
  const startLine = (range[0] ?? 0) + 1
  const endLine = (range.length >= 4 ? (range[2] ?? 0) : (range[0] ?? 0)) + 1
  return { startLine, endLine }
}

/** The SCIP symbol whose Definition occurrence sits within `defRange` in
 *  `ownerFile`, or null. Positional — never string-builds a SCIP symbol. */
export function resolveChangedScipSymbol(
  graph: ScipGraph,
  ownerFile: string,
  defRange: { startLine: number; endLine: number },
): string | null {
  const doc = graph.documents.find((d) => d.relativePath === ownerFile)
  if (doc === undefined) return null
  for (const occ of doc.occurrences) {
    if (!occ.isDefinition) continue
    const occStartLine = (occ.range[0] ?? 0) + 1 // 0-based → 1-based
    if (occStartLine >= defRange.startLine && occStartLine <= defRange.endLine) {
      return occ.symbol
    }
  }
  return null
}

/** Precise callers for each (changedSymbolId, scipSymbol): every non-definition
 *  occurrence of that exact symbol, def site excluded, ordered deterministically. */
export function computePreciseImpact(
  graph: ScipGraph,
  changed: ReadonlyArray<{ changedSymbolId: string; scipSymbol: string; ownerFile: string }>,
): ImpactItem[] {
  const out: ImpactItem[] = []
  for (const c of changed) {
    // occurrencesOf (not raw bySymbol.get) so a `local N` symbol stays scoped
    // to its own document (RFC-258 gate F-03).
    const occs = occurrencesOf(graph, c.scipSymbol, c.ownerFile)
    if (occs.length === 0) continue
    const callers: ImpactCaller[] = []
    for (const { doc, occ } of occs) {
      if (occ.isDefinition) continue // exclude the definition itself
      callers.push({ filePath: doc, range: scipRangeToSource(occ.range) })
    }
    if (callers.length > 0) {
      callers.sort(
        (a, b) => a.filePath.localeCompare(b.filePath) || a.range.startLine - b.range.startLine,
      )
      out.push({ changedSymbolId: c.changedSymbolId, callers, confidence: 'extracted' })
    }
  }
  return out
}

/** Compute precise impact directly from a baseline diff's changed methods +
 *  a SCIP graph. Changed methods whose definition can't be located in the graph
 *  are simply omitted (no precise data for them). */
export function preciseImpactFromBaseline(
  graph: ScipGraph,
  files: ReadonlyArray<FileStructuralDiff>,
): ImpactItem[] {
  const changed: Array<{ changedSymbolId: string; scipSymbol: string; ownerFile: string }> = []
  for (const f of files) {
    for (const ch of f.changes) {
      // Every changed callable (incl. 'added') — so deep mode also surfaces
      // call relationships among new classes, not just edits.
      const node = ch.after ?? ch.before
      if (node === undefined || !CALLABLE.has(node.kind) || node.range === undefined) continue
      const scipSymbol = resolveChangedScipSymbol(graph, f.filePath, node.range)
      if (scipSymbol !== null)
        changed.push({ changedSymbolId: node.id, scipSymbol, ownerFile: f.filePath })
    }
  }
  return computePreciseImpact(graph, changed)
}
