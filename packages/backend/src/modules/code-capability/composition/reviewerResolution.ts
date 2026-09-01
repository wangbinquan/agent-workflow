import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ReviewerResolutionRead } from '../application/ports/reviewerResolutionRead'
import { PostgresqlReviewerResolutionRead } from '../infrastructure/postgresqlReviewerResolutionRead'
import { SqliteReviewerResolutionRead } from '../infrastructure/sqliteReviewerResolutionRead'

export function composeSqliteReviewerResolutionRead(db: DbClient): ReviewerResolutionRead {
  return new SqliteReviewerResolutionRead(db)
}

export function composePostgresqlReviewerResolutionRead(
  db: PostgresqlDatabaseClient,
): ReviewerResolutionRead {
  return new PostgresqlReviewerResolutionRead(db)
}
