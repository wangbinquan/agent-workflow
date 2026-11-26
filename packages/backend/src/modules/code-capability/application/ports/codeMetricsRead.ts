// RFC-349 — provider-neutral persisted rows behind the code metrics projection.

export interface CodeMetricFindingRow {
  readonly capability: string
  readonly resolvedAt: number | null
  readonly codeChangedAt: number | null
  /** Persisted history prefixes return counted buckets; live/frozen readers return one row. */
  readonly n?: number
}

export interface CodeMetricRoundRow {
  readonly capability: string
  readonly outcome: string | null
  readonly endedAt: number | null
  readonly n: number
}

export interface CodeMetricsReadPort {
  loadSince(since: number): Promise<{
    readonly findings: readonly CodeMetricFindingRow[]
    readonly rounds: readonly CodeMetricRoundRow[]
  }>
}
