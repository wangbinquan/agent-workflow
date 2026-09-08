import type { Logger } from '@/util/log'

/** This is a log selection boundary matching the existing histogram bucket;
 * it does not change any maintenance budget or acceptance threshold. */
const SLOW_SLICE_MS = 250
const SQL_TEMPLATE_LIMIT = 300

interface TransactionTimingSummary {
  readonly count: number
  readonly totalMs: number
  readonly maxMs: number
}

export interface MaintenanceSliceDiagnostics {
  observeStatement(ms: number, sql?: string, cpuMs?: number): void
  finish(transactions: TransactionTimingSummary | null, sliceMs?: number): void
}

export function createMaintenanceSliceDiagnostics(input: {
  readonly job: string
  readonly runId: string
  readonly slice: number
  readonly attempt: number
  readonly startedAt: number
  readonly log: Pick<Logger, 'warn'>
  readonly now?: () => number
}): MaintenanceSliceDiagnostics {
  let finished = false
  let statementWallMs = 0
  let statementSql: string | null = null
  let statementProcessCpuMs: number | null = null

  return {
    observeStatement(ms, sql, cpuMs) {
      if (finished || ms <= statementWallMs) return
      statementWallMs = ms
      // Only a new maximum retains a bounded template. The observer receives
      // primitive values and never copies bindings or allocates a row per SQL.
      statementSql =
        sql === undefined
          ? null
          : sql.length > SQL_TEMPLATE_LIMIT
            ? `${sql.slice(0, SQL_TEMPLATE_LIMIT)}…`
            : sql
      // This is the process-wide CPU delta, not exclusive SQL/thread CPU.
      statementProcessCpuMs = cpuMs === undefined || cpuMs < 0 ? null : cpuMs
    },
    finish(transactions, sliceMs) {
      if (finished) return
      finished = true
      // Diagnostics, including a failed clock or sink, must never change a
      // job's completion or failure.
      try {
        const wallMs = sliceMs ?? (input.now?.() ?? performance.now()) - input.startedAt
        if (Math.max(wallMs, statementWallMs, transactions?.maxMs ?? 0) < SLOW_SLICE_MS) return
        input.log.warn('maintenance slice slow', {
          job: input.job,
          runId: input.runId,
          slice: input.slice,
          attempt: input.attempt,
          workerSliceMs: wallMs,
          dbTransactionCount: transactions?.count ?? 0,
          dbTransactionMsTotal: transactions?.totalMs ?? 0,
          dbTransactionMsMax: transactions?.maxMs ?? 0,
          slowestStatementKind:
            statementSql
              ?.trimStart()
              .match(/^[a-z]+/i)?.[0]
              ?.toUpperCase() ?? null,
          slowestStatementSql: statementSql,
          slowestStatementWallMs: statementWallMs,
          slowestStatementProcessCpuMs: statementProcessCpuMs,
        })
      } catch {
        // Existing job outcomes and histogram counters remain authoritative.
      }
    },
  }
}
