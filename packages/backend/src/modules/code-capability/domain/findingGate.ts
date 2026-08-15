// RFC-304 §6 T26 — the `gate` stage: which findings actually reach the author.
//
// Program-only, and the single place that decides how many remarks a person
// sees. Three steps in a fixed order, because the order changes the outcome:
//
//   1. sort deterministically by (severity, file, line)
//   2. filter by the configured severity threshold
//   3. truncate to the per-round cap, and SAY how many were withheld
//
// Sorting first is what makes truncation meaningful: cut an unsorted list and
// which findings survive depends on whatever order the model happened to emit
// them in, so two identical rounds would show different remarks. It also means
// the cap keeps the MOST severe ones rather than an arbitrary sample.
//
// The withheld count is not decoration. A review that silently shows 20 of 63
// problems tells the author their code has 20 problems — and the next round,
// after they fix those, "new" ones appear that were there all along. Naming the
// number is what keeps the reader's model of their own code accurate.

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number]

/** Lower rank sorts first, so blockers lead. */
const SEVERITY_RANK: Record<FindingSeverity, number> = {
  blocker: 0,
  major: 1,
  minor: 2,
  info: 3,
}

export interface GateableFinding {
  severity: FindingSeverity
  file: string
  line: number
}

export interface GateConfig {
  /** Findings below this severity are dropped. */
  threshold: FindingSeverity
  /** Maximum findings published in one round. */
  maxPerRound: number
}

export interface GateResult<T> {
  /** What gets published, in publication order. */
  published: readonly T[]
  /** Dropped for being below the threshold. */
  belowThreshold: number
  /** Dropped by the cap — these ARE above the threshold and would have shipped. */
  truncated: number
}

/**
 * Deterministic ordering: severity, then path, then line.
 *
 * Ties broken all the way down so the comparison is total. A partial order
 * would let two runs over the same findings produce different sequences, and
 * the ledger's cross-round comparison would then report spurious changes.
 */
export function compareFindings(a: GateableFinding, b: GateableFinding): number {
  const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  if (bySeverity !== 0) return bySeverity
  if (a.file !== b.file) return a.file < b.file ? -1 : 1
  return a.line - b.line
}

export function meetsThreshold(severity: FindingSeverity, threshold: FindingSeverity): boolean {
  return SEVERITY_RANK[severity] <= SEVERITY_RANK[threshold]
}

/**
 * Apply the gate.
 *
 * Never throws and never reorders the caller's array in place — the same input
 * always yields the same output, which is what makes a round replayable.
 */
export function applyGate<T extends GateableFinding>(
  findings: readonly T[],
  config: GateConfig,
): GateResult<T> {
  const sorted = [...findings].sort(compareFindings)
  const passing = sorted.filter((f) => meetsThreshold(f.severity, config.threshold))
  const belowThreshold = sorted.length - passing.length

  // A cap of 0 means "publish nothing", which is a legitimate (if odd)
  // configuration; a negative cap is a config error and is treated as 0 rather
  // than as "slice from the end", which is what a raw slice would do.
  const cap = Math.max(0, config.maxPerRound)
  const published = passing.slice(0, cap)
  return { published, belowThreshold, truncated: passing.length - published.length }
}

/**
 * The line the overview carries about what was held back.
 *
 * Two separate numbers because they mean different things to the author: below
 * the threshold is "we saw these and decided they are not worth your time at
 * your configured level"; truncated is "there are more at this level than one
 * round shows". Collapsing them into one "N hidden" would make the second
 * indistinguishable from noise.
 */
export function describeWithheld(result: GateResult<unknown>, threshold: FindingSeverity): string {
  const parts: string[] = []
  if (result.truncated > 0) {
    parts.push(
      `${String(result.truncated)} more finding(s) at or above ${threshold} were not shown this round (per-round cap reached)`,
    )
  }
  if (result.belowThreshold > 0) {
    parts.push(`${String(result.belowThreshold)} finding(s) below ${threshold} were not reported`)
  }
  return parts.join('; ')
}
