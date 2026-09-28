import type { ObservationMeasurement } from '@agent-workflow/shared'
import { TOKEN_BUCKETS, subtractTokenBaseline, type TokenUsage } from './tokenUsage'

export type UsageIssue =
  | 'unknown-inclusion'
  | 'baseline-unknown'
  | 'baseline-exceeds-observation'
  | 'invalid-final'
  | 'unexplained-decrease'
  | 'identity-conflict'

export interface UsageLedgerRecord {
  readonly sourceId: string
  readonly measurement: ObservationMeasurement
  /** Revision used for ordering; may be newer than the last usable measurement. */
  readonly observedRevision: number
  readonly contribution: TokenUsage
  readonly complete: boolean
  readonly issues: readonly UsageIssue[]
}

export type UsageDecision =
  | { readonly outcome: 'stale'; readonly record: UsageLedgerRecord }
  | {
      readonly outcome: 'applied' | 'diagnostic'
      readonly record: UsageLedgerRecord
    }

const unknown: TokenUsage = { input: null, cacheRead: null, cacheWrite: null, output: null }

function sameIdentity(a: ObservationMeasurement, b: ObservationMeasurement): boolean {
  return (
    a.invocationId === b.invocationId &&
    a.recordId === b.recordId &&
    a.taskId === b.taskId &&
    a.nodeRunId === b.nodeRunId &&
    a.agentId === b.agentId &&
    a.reporting === b.reporting &&
    a.inclusion === b.inclusion &&
    JSON.stringify(a.model) === JSON.stringify(b.model) &&
    JSON.stringify(a.basis) === JSON.stringify(b.basis)
  )
}

function diagnostic(
  sourceId: string,
  next: ObservationMeasurement,
  previous: UsageLedgerRecord | undefined,
  issue: UsageIssue,
): UsageDecision {
  return {
    outcome: 'diagnostic',
    record: {
      sourceId,
      measurement: previous?.measurement ?? next,
      observedRevision: next.revision,
      contribution: previous?.contribution ?? unknown,
      complete: false,
      issues: [...new Set([...(previous?.issues ?? []), issue])],
    },
  }
}

/** Fold in revision order. Ingestion rebuilds retained evidence for late older revisions. */
export function reconcileUsage(
  sourceId: string,
  next: ObservationMeasurement,
  previous?: UsageLedgerRecord,
): UsageDecision {
  if (previous && next.revision <= previous.observedRevision)
    return { outcome: 'stale', record: previous }
  if (previous && (previous.sourceId !== sourceId || !sameIdentity(previous.measurement, next)))
    return diagnostic(sourceId, next, previous, 'identity-conflict')
  if (next.validity === 'invalid-final')
    return diagnostic(sourceId, next, previous, 'invalid-final')
  if (
    previous &&
    next.validity !== 'correction' &&
    TOKEN_BUCKETS.some((bucket) => {
      const before = previous.measurement.usage[bucket],
        after = next.usage[bucket]
      return before !== null && after !== null && BigInt(after) < BigInt(before)
    })
  )
    return diagnostic(sourceId, next, previous, 'unexplained-decrease')
  // A missing counter carries no correction evidence. Retain the known lower
  // bound, while completeness still describes the newest report.
  const usage: TokenUsage = {
    input: next.usage.input ?? previous?.measurement.usage.input ?? null,
    cacheRead: next.usage.cacheRead ?? previous?.measurement.usage.cacheRead ?? null,
    cacheWrite: next.usage.cacheWrite ?? previous?.measurement.usage.cacheWrite ?? null,
    output: next.usage.output ?? previous?.measurement.usage.output ?? null,
  }
  let contribution: TokenUsage = usage
  const issues: UsageIssue[] = []
  if (next.basis.kind === 'native-session') {
    if (next.basis.baseline === null) {
      contribution = unknown
      issues.push('baseline-unknown')
    } else {
      try {
        contribution = subtractTokenBaseline(usage, next.basis.baseline)
      } catch {
        return diagnostic(sourceId, next, previous, 'baseline-exceeds-observation')
      }
    }
  }
  if (next.inclusion === 'unknown') issues.push('unknown-inclusion')
  return {
    outcome: 'applied',
    record: {
      sourceId,
      measurement: { ...next, usage },
      observedRevision: next.revision,
      contribution,
      complete:
        next.coverage === 'complete' &&
        issues.length === 0 &&
        TOKEN_BUCKETS.every((bucket) => next.usage[bucket] !== null) &&
        TOKEN_BUCKETS.every((bucket) => contribution[bucket] !== null),
      issues,
    },
  }
}
