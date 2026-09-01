import {
  createPostgresqlResourceScopeAccessParticipant,
  type PostgresqlResourceScopeAccessParticipant,
} from '../infrastructure/aggregateAdapters/postgresqlResourceScopeAuthorization'

/** Bootstrap-only composition seam for the PostgreSQL Memory atomic port. */
export function composePostgresqlResourceScopeAccessParticipant(): PostgresqlResourceScopeAccessParticipant {
  return createPostgresqlResourceScopeAccessParticipant()
}
