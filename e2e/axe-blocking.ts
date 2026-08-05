// RFC-254 T35 — one place that turns an axe scan into a *diagnosable* assertion.
//
// WHY THIS EXISTS
// ---------------
// Sixteen specs independently wrote `violations.filter(v => v.impact ===
// 'critical' || v.impact === 'serious')` and then asserted on the ids alone:
//
//   expect(blocking.map((v) => v.id)).toEqual([])
//
// That reads well and is useless when it fails. `e2e/intent-builder.spec.ts`
// went red three times on the Windows leg with the message
// `+ Array [ "color-contrast" ]` and nothing else — no element, no colours, no
// ratio. Three CI runs produced zero evidence, so nobody could tell a
// platform rendering artefact from a real dark-mode contrast defect, and the
// entry sat in `docs/audit-backlog.md` un-actionable.
//
// The assertion semantics are unchanged: still "no blocking violations", still
// an empty-array comparison. Only the failure text gets richer, and it gets
// richer for every caller at once rather than for whichever spec someone
// happened to be debugging.

import type { AxeResults, Result, NodeResult, CheckResult } from 'axe-core'

/** Blocking = the two impact levels the suite gates on. */
export function blockingViolations(results: AxeResults): Result[] {
  return results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious')
}

/**
 * `data` is typed `unknown` on CheckResult because every axe check writes its
 * own shape. For colour-contrast it carries the numbers that actually decide
 * the verdict, so surface them verbatim rather than re-deriving anything.
 */
function describeCheckData(data: unknown): string {
  if (data === null || typeof data !== 'object') return ''
  const d = data as Record<string, unknown>
  const parts: string[] = []
  for (const key of [
    'fgColor',
    'bgColor',
    'contrastRatio',
    'expectedContrastRatio',
    'fontSize',
    'fontWeight',
  ]) {
    if (d[key] !== undefined) parts.push(`${key}=${String(d[key])}`)
  }
  return parts.join(' ')
}

function describeNode(node: NodeResult): string {
  const target = Array.isArray(node.target) ? node.target.join(' ') : String(node.target)
  const checks: CheckResult[] = [...(node.any ?? []), ...(node.all ?? []), ...(node.none ?? [])]
  const facts = checks.map((c) => describeCheckData(c.data)).filter((s) => s.length > 0)
  const html = node.html.replace(/\s+/g, ' ').slice(0, 160)
  return `      at ${target}${facts.length > 0 ? ` [${facts.join(' | ')}]` : ''}\n        ${html}`
}

/**
 * One string per blocking violation, carrying the element, the check's own
 * numbers and a trimmed HTML snippet. Assert on THIS, not on `.map(v => v.id)`
 * — an empty array reads identically on success and the failure names the
 * element and the colours.
 */
export function describeBlocking(results: AxeResults): string[] {
  return blockingViolations(results).map((v) => {
    const nodes = v.nodes.map(describeNode).join('\n')
    return `${v.id} (${v.impact ?? 'unknown'}) × ${v.nodes.length}\n${nodes}`
  })
}
