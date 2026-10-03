import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseRuntime } from './postgresqlRuntime'
import { originalPostgresqlReportSnapshot } from './reportPostgresqlSnapshot'
import { originalSqliteReportSnapshot } from './reportSqliteSnapshot'
import type { ReportSnapshotSession } from './reportSnapshotTypes'
export type OriginalReportDatabaseBinding =
  | { readonly provider: 'sqlite'; readonly db: DbClient; readonly generationId: string }
  | { readonly provider: 'postgresql'; readonly runtime: PostgresqlDatabaseRuntime }
/** Provider selection belongs to the platform; application receives one snapshot contract. */
export function originalReportSnapshotSession(
  binding: OriginalReportDatabaseBinding,
): ReportSnapshotSession {
  return binding.provider === 'sqlite'
    ? originalSqliteReportSnapshot(binding)
    : originalPostgresqlReportSnapshot(binding.runtime)
}
