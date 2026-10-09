import { createLogger } from '@/util/log'
import type { CompleteWorkingRows } from '../ports/completeWorkingRows'
import type { HistoricalObservationSources } from '../ports/historicalObservationSources'

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

export interface CompleteReportOperationSample {
  readonly reportId: string
  readonly operation: string
  readonly calls: string
  readonly timedCalls: string
  readonly totalMs: number | null
}

/** A diagnostic failure must never prevent, repeat, or replace the original operation. */
export function completeReportOperationObserver(
  reportId: string,
  refreshKey: string,
  options: {
    readonly now?: () => number
    readonly emit?: (sample: CompleteReportOperationSample) => void
  } = {},
) {
  if (!refreshKey.startsWith('load-performance-')) return undefined
  try {
    const now = options.now ?? (() => performance.now()),
      log = createLogger('run-observability.report-performance'),
      emit =
        options.emit ??
        ((sample: CompleteReportOperationSample) =>
          log.info('Complete report operation', { ...sample })),
      samples = new Map<string, { calls: bigint; timedCalls: bigint; totalMs: number }>()
    let flushed = false
    const stamp = () => {
      try {
        const value = now()
        return Number.isFinite(value) ? value : null
      } catch {
        return null
      }
    }
    const record = (operation: string, started: number | null) => {
      try {
        if (flushed) return
        const sample = samples.get(operation) ?? { calls: 0n, timedCalls: 0n, totalMs: 0 }
        sample.calls++
        const ended = stamp()
        if (started !== null && ended !== null && ended >= started) {
          sample.timedCalls++
          sample.totalMs += ended - started
        }
        samples.set(operation, sample)
      } catch {
        // Recording is diagnostic only, including on the original failure path.
      }
    }
    return {
      measureSync<T>(operation: string, work: () => T): T {
        const started = stamp()
        try {
          return work()
        } finally {
          record(operation, started)
        }
      },
      async measure<T>(operation: string, work: () => Promise<T>): Promise<T> {
        const started = stamp()
        try {
          return await work()
        } finally {
          record(operation, started)
        }
      },
      flush() {
        if (flushed) return
        flushed = true
        for (const [operation, sample] of samples) {
          try {
            emit({
              reportId,
              operation,
              calls: String(sample.calls),
              timedCalls: String(sample.timedCalls),
              totalMs:
                sample.calls === sample.timedCalls ? Number(sample.totalMs.toFixed(2)) : null,
            })
          } catch {
            // A logger failure cannot change the report or suppress its original exception.
          }
        }
      },
    }
  } catch {
    return undefined
  }
}

/** Decorate the same original source objects, preserving their method receivers and contracts. */
export function measureCompleteReportSources(
  observer: NonNullable<ReturnType<typeof completeReportOperationObserver>>,
  rows: CompleteWorkingRows,
  historical: HistoricalObservationSources | undefined,
) {
  const measuredRows: CompleteWorkingRows = {
    insert: (...args) => observer.measure('workspace.insert', () => rows.insert(...args)),
    put: (...args) => observer.measure('workspace.put', () => rows.put(...args)),
    upsert: (...args) => observer.measure('workspace.upsert', () => rows.upsert(...args)),
    get: <T>(namespace: string, key: string) =>
      observer.measure('workspace.get', () => rows.get<T>(namespace, key)),
    getMany: <T>(namespace: string, keys: readonly string[]) =>
      observer.measure('workspace.getMany', () => rows.getMany<T>(namespace, keys)),
    page: <T>(...args: [namespace: string, after: string | null, size?: number]) =>
      observer.measure('workspace.page', () => rows.page<T>(...args)),
    clear: (...args) => observer.measure('workspace.clear', () => rows.clear(...args)),
  }
  const measuredHistorical: HistoricalObservationSources | undefined = historical
    ? {
        ...historical,
        native: {
          async open(input) {
            const reader = await observer.measure('native.open', () =>
              historical.native.open(input),
            )
            return reader
              ? {
                  ...reader,
                  next: (cursor: string) =>
                    observer.measureSync('native.next', () => reader.next(cursor)),
                  acknowledge: (ordinal: string, digest: string) =>
                    observer.measureSync('native.acknowledge', () =>
                      reader.acknowledge(ordinal, digest),
                    ),
                  close: () => observer.measureSync('native.close', () => reader.close()),
                }
              : null
          },
          generation: () =>
            observer.measure('native.generation', () => historical.native.generation()),
        },
      }
    : undefined
  return { rows: measuredRows, historical: measuredHistorical }
}
