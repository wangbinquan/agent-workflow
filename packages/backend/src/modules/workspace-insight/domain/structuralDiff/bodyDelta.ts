// RFC-083 logic detail (#6) — "how much logic changed" for a modified callable,
// as line-level added/removed counts. A line MULTISET diff (not a true LCS):
// cheap, order-insensitive, and good enough to answer "small tweak vs rewrite"
// at a glance. The exact hunks are already reachable via hunkAnchor → textual
// diff; this is the structural summary number.

import type { SymbolChange } from '@agent-workflow/shared'
import { CALLABLE } from './impact'

/** Added/removed line counts treating each side as a multiset of trimmed,
 *  non-empty lines. `added` = new lines with no old counterpart; `removed` =
 *  old lines with no new counterpart. */
export function lineMultisetDelta(
  oldLines: readonly string[],
  newLines: readonly string[],
): { added: number; removed: number } {
  const counts = new Map<string, number>()
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1)
  let added = 0
  for (const l of newLines) {
    const c = counts.get(l) ?? 0
    if (c > 0) counts.set(l, c - 1)
    else added += 1
  }
  let removed = 0
  for (const c of counts.values()) removed += c
  return { added, removed }
}

function bodyLines(text: string, range: { startLine: number; endLine: number }): string[] {
  return text
    .split('\n')
    .slice(range.startLine - 1, range.endLine)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** The line delta for a modified callable, or undefined when it doesn't apply
 *  (non-modified, non-callable, missing range/text, or a no-op delta). */
export function bodyDeltaFor(
  change: SymbolChange,
  oldText: string | null,
  newText: string | null,
): { added: number; removed: number } | undefined {
  if (change.changeType !== 'modified') return undefined
  const { before, after } = change
  if (
    before === undefined ||
    after === undefined ||
    !CALLABLE.has(after.kind) ||
    before.range === undefined ||
    after.range === undefined ||
    oldText === null ||
    newText === null
  ) {
    return undefined
  }
  const delta = lineMultisetDelta(bodyLines(oldText, before.range), bodyLines(newText, after.range))
  if (delta.added === 0 && delta.removed === 0) return undefined
  return delta
}
