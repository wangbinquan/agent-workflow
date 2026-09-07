// RFC-349 — compatibility facade. User persistence lives in identity-access;
// production callers use its Promise operations while compatibility callers keep
// their established fixture helpers during the cutover.

import { legacyUserService } from '@/modules/identity-access/composition/legacyUserService'

export const {
  countNonSystemUsers,
  createUser,
  disableUser,
  enableUser,
  findById,
  findByUsername,
  getUserGitCommitIdentity,
  listAllUsers,
  lookupUsersPublic,
  patchUser,
  resetPassword,
  searchUsersPublic,
} = legacyUserService

export type UserRow = NonNullable<Awaited<ReturnType<typeof findById>>>
export type CreateUserInput = Parameters<typeof createUser>[1]
export type ResetPasswordInput = Parameters<typeof resetPassword>[2]
export type SearchInput = Parameters<typeof searchUsersPublic>[1]
