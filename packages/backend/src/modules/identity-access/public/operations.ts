// RFC-344 — transport-neutral user-access operation descriptors.
//
// RFC-551 (RFC-294 S9): the factory that builds them, its dependencies and the input / output schemas moved into
// `application/userOperationDescriptors.ts` (no other module called it); the contract stays here.

import type { z } from 'zod'
import type { AdminUserView, UserPublic } from '@agent-workflow/shared'
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
} from '@/platform/operations/contracts'
import type {
  createUserInputSchema,
  disableUserInputSchema,
  lookupUsersInputSchema,
  resetPasswordInputSchema,
  searchUsersInputSchema,
  updateUserInputSchema,
} from '../application/userOperationDescriptors'
import type { CommandContext, QueryContext } from './participants'

export type { OidcProviderRepository } from '../application/ports/oidcProviderPersistence'
export { DrizzleOidcProviderRepository } from '../infrastructure/oidcProviderRepository'
export { type OwnerIdentityQueries } from '../application/ports/ownerIdentityQueries'

export interface IdentityUserOperations {
  readonly listUsers: QueryOperationDescriptor<
    Record<never, never>,
    ReadonlyArray<AdminUserView>,
    QueryContext
  >
  readonly getUser: QueryOperationDescriptor<
    { readonly userId: string },
    AdminUserView | null,
    QueryContext
  >
  readonly searchUsers: QueryOperationDescriptor<
    z.infer<typeof searchUsersInputSchema>,
    ReadonlyArray<UserPublic>,
    QueryContext
  >
  readonly lookupUsers: QueryOperationDescriptor<
    z.infer<typeof lookupUsersInputSchema>,
    ReadonlyArray<UserPublic>,
    QueryContext
  >
  readonly createUser: CommandOperationDescriptor<
    z.infer<typeof createUserInputSchema>,
    AdminUserView,
    CommandContext
  >
  readonly updateUser: CommandOperationDescriptor<
    z.infer<typeof updateUserInputSchema>,
    AdminUserView,
    CommandContext
  >
  readonly disableUser: CommandOperationDescriptor<
    z.infer<typeof disableUserInputSchema>,
    { readonly ok: true; readonly code: 'user-deletion-soft' },
    CommandContext
  >
  readonly resetPassword: CommandOperationDescriptor<
    z.infer<typeof resetPasswordInputSchema>,
    { readonly ok: true },
    CommandContext
  >
}
