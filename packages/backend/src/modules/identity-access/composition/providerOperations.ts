// RFC-349 — bootstrap and legacy-facade composition for provider-owned
// Identity Access mechanisms.  These factories intentionally stay out of the
// public contract surface: other bounded contexts consume the closed ports,
// while bootstrap selects the concrete provider exactly once.

export {
  composePostgresqlOidcIdentityOperations,
  createPostgresqlIdentityAccessCrossContextBindings,
} from '../infrastructure/postgresqlOidcIdentityCrossContext'
export { composeSqliteOidcIdentityOperations } from '../infrastructure/sqliteOidcIdentityCrossContext'
export {
  composePostgresqlOwnerIdentityQueries,
  composeSqliteOwnerIdentityQueries,
} from './ownerIdentityQueries'
export { sqliteOwnerScopedNameWhere } from '../infrastructure/sqliteOwnerScopedName'
