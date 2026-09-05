import type { DbClient } from '@/db/client'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type { ReviewerResolutionRead } from '../application/ports/reviewerResolutionRead'
import { DrizzleReviewerResolutionRead } from '../infrastructure/reviewerResolutionRead'

// RFC-359：两个 provider 共用一份实现；两个具名入口保留给 bootstrap，收敛后合成一个。
export function composeSqliteReviewerResolutionRead(db: DbClient): ReviewerResolutionRead {
  return new DrizzleReviewerResolutionRead(db)
}

export function composePostgresqlReviewerResolutionRead(
  db: PostgresqlDatabaseClient,
): ReviewerResolutionRead {
  return new DrizzleReviewerResolutionRead(db)
}
