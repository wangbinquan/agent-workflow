import { createLogger } from '@/util/log'

export interface CompleteReportPerformanceSample {
  readonly reportId: string
  readonly phase: string
  readonly elapsedMs: number
  readonly phaseMs: number
}

/** Opt-in elapsed diagnostics never participate in report facts or fail the original build. */
export function completeReportPerformanceObserver(
  reportId: string,
  refreshKey: string,
  options: {
    readonly now?: () => number
    readonly emit?: (sample: CompleteReportPerformanceSample) => void
  } = {},
): ((phase: string) => void) | undefined {
  try {
    if (!refreshKey.startsWith('load-performance-')) return undefined
    const now = options.now ?? (() => performance.now()),
      log = createLogger('run-observability.report-performance'),
      emit =
        options.emit ??
        ((sample: CompleteReportPerformanceSample) =>
          log.info('Complete report phase', { ...sample })),
      started = now()
    if (!Number.isFinite(started)) return undefined
    let previous = started
    return (phase) => {
      try {
        const at = now()
        if (!Number.isFinite(at) || at < previous) return
        const sample = {
          reportId,
          phase,
          elapsedMs: Number((at - started).toFixed(2)),
          phaseMs: Number((at - previous).toFixed(2)),
        }
        previous = at
        emit(sample)
      } catch {
        // Clock/logger failure discards diagnostics only; original source work is outside this catch.
      }
    }
  } catch {
    return undefined
  }
}
