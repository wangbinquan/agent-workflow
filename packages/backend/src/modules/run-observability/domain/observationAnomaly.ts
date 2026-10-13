import type { ObservationAnomaly } from '@agent-workflow/shared'
export interface ObservationAnomalySample {
  key: string
  taskId: string | null
  taskName: string | null
  rule: ObservationAnomaly['rule']
  condition: boolean | null
  sourceState: ObservationAnomaly['sourceState']
  samples: string
  minimumSamples: string
  windowMs: number
  durationMs: number
  observedAt: number
  evidence: readonly string[]
  sourceRevision: string
  conditionStartedAt?: number | null
}
/** Missing/stale sampling is independent of business outcome and cannot resolve an active finding. */
export function advanceObservationAnomaly(
  previous: ObservationAnomaly | undefined,
  s: ObservationAnomalySample,
  newId: () => string,
): ObservationAnomaly | undefined {
  if (previous && s.observedAt < previous.lastObservedAt)
    throw new Error('Original anomaly sample clock regressed')
  if (s.sourceState !== 'available' || s.condition === null)
    return previous ? { ...previous, sourceState: s.sourceState } : undefined
  const qualified = BigInt(s.samples) >= BigInt(s.minimumSamples)
  if (!qualified) return previous
  if (!s.condition) {
    if (!previous || previous.state === 'resolved') return previous
    return {
      ...previous,
      state: 'resolved',
      sourceState: 'available',
      lastObservedAt: s.observedAt,
      resolvedAt: s.observedAt,
      revision: String(BigInt(previous.revision) + 1n),
      evidence: [...s.evidence],
    }
  }
  const start =
      !previous || previous.state === 'resolved'
        ? (s.conditionStartedAt ?? s.observedAt)
        : previous.firstObservedAt,
    firing = s.observedAt - start >= s.durationMs
  if (!previous || previous.state === 'resolved')
    return {
      id: newId(),
      key: s.key,
      taskId: s.taskId,
      taskName: s.taskName,
      rule: s.rule,
      state: firing ? 'firing' : 'pending',
      sourceState: 'available',
      samples: s.samples,
      minimumSamples: s.minimumSamples,
      windowMs: s.windowMs,
      durationMs: s.durationMs,
      firstObservedAt: start,
      lastObservedAt: s.observedAt,
      firedAt: firing ? s.observedAt : null,
      resolvedAt: null,
      evidence: [...s.evidence],
      revision: '1',
    }
  return {
    ...previous,
    taskName: s.taskName ?? previous.taskName,
    state: firing ? 'firing' : 'pending',
    sourceState: 'available',
    samples: s.samples,
    lastObservedAt: s.observedAt,
    firedAt: firing ? (previous.firedAt ?? s.observedAt) : null,
    revision:
      previous.lastObservedAt === s.observedAt
        ? previous.revision
        : String(BigInt(previous.revision) + 1n),
    evidence: [...s.evidence],
  }
}
