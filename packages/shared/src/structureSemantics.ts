// RFC-088 — structural-diff semantics (pure). Hoisted to shared by RFC-239 so
// the change-group model (frontend sidebar + backend narrative input) computes
// severity from ONE implementation. Turns the engine's already-computed
// SymbolChange fields into (a) a human-readable explanation, (b) a breaking-risk
// classification, and (c) ordering/filtering + a "walkthrough" top-N.
//
// All diff-INTERNAL: we classify breakage from what the diff itself proves
// (a removed/renamed/visibility-narrowed public symbol, a public signature whose
// params changed). We do NOT chase cross-file callers — that needs deep/SCIP
// impact. visibility comes from RFC-087; when it's missing (older artifacts /
// degraded langs) we degrade conservatively to 'risky' + uncertain rather than
// silently calling a real break 'safe'.
//
// Dependency note (RFC-239 design gate P1-1/P1-N2): the frontend original used
// the npm `diff` package (diffWordsWithSpace) to detect removed signature
// tokens. shared stays third-party-free, so the detection here is an
// order-SENSITIVE token LCS — "has removed tokens" ⟺ LCS(before, after) is
// shorter than `before` — which is the same predicate a minimal word-level
// edit script answers. Signatures are short; the O(n²) DP is negligible.

import type { SymbolChange, SymbolNode } from './schemas/structuralDiff'

export type Severity = 'breaking' | 'risky' | 'safe'

export type BreakingReason =
  | 'removed-public'
  | 'signature-param-change'
  | 'visibility-narrowed'
  | 'renamed-public'
  | 'added'
  | 'body-only'
  | 'private-change'
  | 'unknown-visibility'

export interface BreakingVerdict {
  severity: Severity
  reason: BreakingReason
  /** true when the verdict had to assume visibility because the symbol didn't
   *  carry it (older artifact / degraded grammar). UI surfaces "visibility
   *  unknown" so the reviewer knows it's a conservative guess. */
  uncertain: boolean
}

/** Visible to callers outside the declaring scope. Unknown visibility
 *  (undefined) is treated as visible — conservative, so we never downgrade a
 *  possible break to 'safe'. Only an explicit `private` is "not visible". */
function isPublicLike(node: SymbolNode | undefined): boolean {
  return node !== undefined && node.visibility !== 'private'
}

export const SEVERITY_RANK: Record<Severity, number> = { breaking: 0, risky: 1, safe: 2 }

/** Word/whitespace/punctuation tokenizer mirroring diffWordsWithSpace's
 *  granularity closely enough for declaration signatures: identifier runs,
 *  whitespace runs, and single punctuation characters. */
function tokenizeSignature(s: string): string[] {
  return s.match(/[A-Za-z0-9_$]+|\s+|[^\sA-Za-z0-9_$]/g) ?? []
}

/** Order-sensitive "did the old signature lose any token" predicate.
 *  false when either side is empty or both are identical (mirrors
 *  diffSignatureTokens returning null there). Otherwise true ⟺ the token LCS
 *  is shorter than `before`'s token count — i.e. a minimal word-level edit
 *  script would flag at least one removed token. Order-sensitive on purpose:
 *  parameter reorders and duplicate-token swaps keep the multiset but DO
 *  produce removed tokens (design gate 3rd-round P1-N2). */
export function signatureTokensRemoved(
  before: string | undefined,
  after: string | undefined,
): boolean {
  const b = before ?? ''
  const a = after ?? ''
  if (b === '' || a === '' || b === a) return false
  const bt = tokenizeSignature(b)
  const at = tokenizeSignature(a)
  // classic LCS length DP over token arrays
  const cols = at.length + 1
  let prev = new Array<number>(cols).fill(0)
  let curr = new Array<number>(cols).fill(0)
  for (let i = 1; i <= bt.length; i++) {
    curr[0] = 0
    for (let j = 1; j <= at.length; j++) {
      curr[j] =
        bt[i - 1] === at[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0)
    }
    ;[prev, curr] = [curr, prev]
  }
  const lcs = prev[at.length] ?? 0
  return lcs < bt.length
}

/** Classify the breaking risk of a single change from diff-internal facts.
 *  First matching rule wins (see RFC-088 design.md §2.1). */
export function classifyBreaking(change: SymbolChange): BreakingVerdict {
  const { before, after } = change

  if (change.changeType === 'added') {
    return { severity: 'safe', reason: 'added', uncertain: false }
  }

  if (change.changeType === 'removed') {
    if (before?.visibility === 'private') {
      return { severity: 'safe', reason: 'private-change', uncertain: false }
    }
    const uncertain = before?.visibility === undefined
    return uncertain
      ? { severity: 'risky', reason: 'unknown-visibility', uncertain: true }
      : { severity: 'breaking', reason: 'removed-public', uncertain: false }
  }

  if (change.changeType === 'renamed' || change.changeType === 'moved') {
    if (after?.visibility === 'private') {
      return { severity: 'safe', reason: 'private-change', uncertain: false }
    }
    const uncertain = after?.visibility === undefined
    return {
      severity: 'risky',
      reason: uncertain ? 'unknown-visibility' : 'renamed-public',
      uncertain,
    }
  }

  // modified
  // 1) visibility narrowed: a known-visible symbol became private.
  if (
    before?.visibility !== undefined &&
    before.visibility !== 'private' &&
    after?.visibility === 'private'
  ) {
    return { severity: 'breaking', reason: 'visibility-narrowed', uncertain: false }
  }
  // 2) signature change on a still-visible symbol that dropped/changed a param.
  if (change.signatureChanged === true && after?.visibility !== 'private') {
    if (signatureTokensRemoved(before?.signature, after?.signature)) {
      const uncertain = after?.visibility === undefined
      return uncertain
        ? { severity: 'risky', reason: 'unknown-visibility', uncertain: true }
        : { severity: 'breaking', reason: 'signature-param-change', uncertain: false }
    }
    // additive/typo signature change — callers may need updating but it isn't a
    // proven break.
    return { severity: 'risky', reason: 'signature-param-change', uncertain: false }
  }
  // 3) body-only change (signature intact).
  if (change.bodyChanged === true || change.bodyDelta !== undefined) {
    return { severity: 'safe', reason: 'body-only', uncertain: false }
  }
  return { severity: 'safe', reason: 'private-change', uncertain: false }
}

/** i18n key + interpolation vars for a one-line, plain-language explanation of
 *  the change. Keyed by changeType (+ visibility for removed/renamed, +
 *  signatureChanged for modified) so the sentence is always informative; the
 *  severity chip carries the risk level. */
export function explainChange(change: SymbolChange): {
  key: string
  vars: { name: string; kind: string; from: string }
} {
  const node = change.after ?? change.before
  const vars = {
    name: node?.name ?? node?.qualifiedName ?? '?',
    kind: change.kind,
    from: change.renamedFrom ?? '',
  }
  let key: string
  switch (change.changeType) {
    case 'added':
      key = 'tasks.structExplainAdded'
      break
    case 'removed':
      key = isPublicLike(change.before)
        ? 'tasks.structExplainRemovedPublic'
        : 'tasks.structExplainRemovedPrivate'
      break
    case 'renamed':
      key = 'tasks.structExplainRenamed'
      break
    case 'moved':
      key = 'tasks.structExplainMoved'
      break
    case 'modified':
      key = change.signatureChanged === true ? 'tasks.structExplainSig' : 'tasks.structExplainBody'
      break
  }
  return { key, vars }
}

export type SortBy = 'name' | 'severity'

export interface ChangeFilter {
  changeTypes?: ReadonlySet<SymbolChange['changeType']>
  severities?: ReadonlySet<Severity>
}

function changeName(c: SymbolChange): string {
  const node = c.after ?? c.before
  return node?.qualifiedName ?? node?.name ?? ''
}

/** Order (and optionally filter) a file's changes. `severity` sorts
 *  breaking→risky→safe (ties: name); `name` is dictionary order. An empty/absent
 *  filter keeps everything. */
export function orderAndFilterChanges(
  changes: SymbolChange[],
  by: SortBy,
  filter?: ChangeFilter,
): SymbolChange[] {
  const ct = filter?.changeTypes
  const sv = filter?.severities
  const kept = changes.filter((c) => {
    if (ct !== undefined && ct.size > 0 && !ct.has(c.changeType)) return false
    if (sv !== undefined && sv.size > 0 && !sv.has(classifyBreaking(c).severity)) return false
    return true
  })
  const withName = kept.map((c) => ({
    c,
    name: changeName(c),
    rank: SEVERITY_RANK[classifyBreaking(c).severity],
  }))
  withName.sort((a, b) =>
    by === 'severity' && a.rank !== b.rank ? a.rank - b.rank : a.name.localeCompare(b.name),
  )
  return withName.map((x) => x.c)
}

export interface WalkthroughItem {
  filePath: string
  change: SymbolChange
  severity: Severity
}

/** Top-N most-worth-reviewing changes across all files, severity-descending
 *  (breaking first), then file/declaration order. Safe-only changes are
 *  excluded — the walkthrough is the "look here first" list, not a full dump. */
export function walkthroughItems(
  files: ReadonlyArray<{ filePath: string; changes: SymbolChange[] }>,
  limit: number,
): WalkthroughItem[] {
  const all: WalkthroughItem[] = []
  for (const f of files) {
    for (const change of f.changes) {
      const severity = classifyBreaking(change).severity
      if (severity !== 'safe') all.push({ filePath: f.filePath, change, severity })
    }
  }
  all.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return all.slice(0, limit)
}

/** Count of changes at each severity across all files (for the summary card +
 *  whether the walkthrough should render at all). */
export function severityCounts(
  files: ReadonlyArray<{ changes: SymbolChange[] }>,
): Record<Severity, number> {
  const counts: Record<Severity, number> = { breaking: 0, risky: 0, safe: 0 }
  for (const f of files) for (const c of f.changes) counts[classifyBreaking(c).severity] += 1
  return counts
}
