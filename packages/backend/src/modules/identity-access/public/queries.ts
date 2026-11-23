export { GetUserProfile } from '../application/queries/getUserProfile'
// RFC-552 (RFC-294 S9): the owner identity read port is a query, not an operation descriptor; it moved here from
// `public/operations`.
export type { OwnerIdentityQueries } from '../application/ports/ownerIdentityQueries'
