import type { DbClient } from '@/db/client'
import { unhandledDatabaseProvider } from './databaseProviders'
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
  if (binding.provider === 'sqlite') return originalSqliteReportSnapshot(binding)
  if (binding.provider === 'postgresql') return originalPostgresqlReportSnapshot(binding.runtime)
  return unhandledDatabaseProvider(binding)
}
