// RFC-349 — bootstrap and legacy-facade composition for provider-owned
// Identity Access mechanisms.  These factories intentionally stay out of the
// public contract surface: other bounded contexts consume the closed ports,
// while bootstrap selects the concrete provider exactly once.
//
// RFC-359 W4-D8：OIDC 身份操作与 owner 身份查询各只剩一份 provider-中立实现，入口名不再带 provider。

export { composeOidcIdentityOperations } from '../infrastructure/oidcIdentityCrossContext'
export { composeOwnerIdentityQueries } from './ownerIdentityQueries'
export { sqliteOwnerScopedNameWhere } from '../infrastructure/sqliteOwnerScopedName'
