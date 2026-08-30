// RFC-344 — transport-neutral user-access operation descriptors.

import { z } from 'zod'
import {
  AdminUserViewSchema,
  CreateUserBodySchema,
  ResetPasswordBodySchema,
  RoleSchema,
  UserAccessPatchSchema,
  UserPublicSchema,
  UserSchema,
  type AdminUserView,
  type UserPublic,
} from '@agent-workflow/shared'
import type { CreateManagedUser, UpdateUserAccess } from './commands'
import type { DirectCommandContextFactory } from './participants'
import type { CommandContext, QueryContext } from './participants'
import type { GetUserAccess } from './queries'
import type { AdminUserAccessView } from './types'
import { operationId } from '@/platform/operations/catalog'
import { zodOperationCodec } from '@/platform/operations/codecs'
import type {
  CommandOperationDescriptor,
  QueryOperationDescriptor,
  VersionedExactCodec,
} from '@/platform/operations/contracts'

const PUBLIC_ERRORS = Object.freeze([
  'not-found',
  'forbidden',
  'validation-failed',
  'conflict',
  'resource-operation-stale',
  'internal-error',
] as const)

const exactAdminUserViewSchema = AdminUserViewSchema.extend({
  username: UserSchema.shape.username.or(z.literal('__system__')),
}).strict()
const exactUserPublicSchema = UserPublicSchema.strict()
const emptyInputSchema = z.object({}).strict()
const getUserInputSchema = z.object({ userId: z.string().min(1) }).strict()
const searchUsersInputSchema = z
  .object({
    q: z.string().optional(),
    limit: z.number().int().min(1).max(100),
    excludeIds: z.array(z.string().min(1)).max(200),
    status: UserSchema.shape.status.optional(),
  })
  .strict()
const lookupUsersInputSchema = z.object({ ids: z.array(z.string().min(1)).max(200) }).strict()
const createUserInputSchema = CreateUserBodySchema.strict()
const updateUserInputSchema = z
  .object({
    targetUserId: z.string().min(1),
    displayName: UserSchema.shape.displayName.optional(),
    email: UserSchema.shape.email.optional(),
    role: RoleSchema.optional(),
    access: UserAccessPatchSchema.optional(),
    status: UserSchema.shape.status.optional(),
    forcePasswordChange: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role !== undefined && value.access !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'user-access-ambiguous',
        path: ['access'],
      })
    }
  })
const disableUserInputSchema = z.object({ targetUserId: z.string().min(1) }).strict()
const resetPasswordInputSchema = z
  .object({
    targetUserId: z.string().min(1),
    ...ResetPasswordBodySchema.shape,
  })
  .strict()
const okSchema = z.object({ ok: z.literal(true) }).strict()
const softDeleteSchema = z
  .object({ ok: z.literal(true), code: z.literal('user-deletion-soft') })
  .strict()

export interface IdentityUserOperationDeps {
  readonly contexts: DirectCommandContextFactory
  readonly createManagedUser: CreateManagedUser
  readonly updateUserAccess: UpdateUserAccess
  readonly getUserAccess: GetUserAccess
  readonly id: () => string
  readonly hashPassword: (plaintext: string) => Promise<string>
  readonly oidcManagedUserIds: (userIds: readonly string[]) => Promise<ReadonlySet<string>>
  readonly isOidcManagedUser: (userId: string) => Promise<boolean>
  readonly searchUsers: (input: {
    q?: string
    limit: number
    excludeIds: string[]
    status?: UserPublic['status']
  }) => Promise<UserPublic[]>
  readonly lookupUsers: (ids: string[]) => Promise<UserPublic[]>
  readonly resetPassword: (input: {
    userId: string
    newPassword: string
    force?: boolean
  }) => Promise<void>
  readonly afterDisabled: (input: { userId: string; at: number }) => Promise<void>
}

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

function descriptorBase<I, O>(input: {
  id: string
  summary: string
  permissions: ReadonlyArray<'users:read' | 'users:search' | 'users:write'>
  inputCodec: VersionedExactCodec<I>
  outputCodec: VersionedExactCodec<O>
}) {
  return {
    id: operationId(input.id),
    summary: input.summary,
    input: input.inputCodec,
    output: input.outputCodec,
    publicErrors: PUBLIC_ERRORS,
    permissions: input.permissions,
  } as const
}

function materializeAdminUser(row: AdminUserAccessView, hasOidcIdentity: boolean): AdminUserView {
  return exactAdminUserViewSchema.parse({
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    forcePasswordChange: row.forcePasswordChange,
    createdBy: row.history.createdBy,
    createdAt: row.history.createdAt,
    updatedAt: row.history.updatedAt,
    lastLoginAt: row.history.lastLoginAt,
    additionalPermissions: row.additionalPermissions,
    accessRevision: row.accessRevision,
    hasOidcIdentity,
  })
}

export function createIdentityUserOperations(
  deps: IdentityUserOperationDeps,
): IdentityUserOperations {
  const listUsers: IdentityUserOperations['listUsers'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.list-users.v1',
      summary: 'List users',
      permissions: ['users:read'],
      inputCodec: zodOperationCodec('identity-access.list-users.input.v1', emptyInputSchema),
      outputCodec: zodOperationCodec(
        'identity-access.list-users.output.v1',
        z.array(exactAdminUserViewSchema),
      ),
    }),
    kind: 'query',
    contextKind: 'authenticated-query',
    async invoke(context: QueryContext) {
      const rows = await deps.getUserAccess.list(context)
      const managed = await deps.oidcManagedUserIds(rows.map((row) => row.id))
      return rows.map((row) => materializeAdminUser(row, managed.has(row.id)))
    },
  })

  const getUser: IdentityUserOperations['getUser'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.get-user.v1',
      summary: 'Get one user',
      permissions: ['users:read'],
      inputCodec: zodOperationCodec('identity-access.get-user.input.v1', getUserInputSchema),
      outputCodec: zodOperationCodec(
        'identity-access.get-user.output.v1',
        exactAdminUserViewSchema.nullable(),
      ),
    }),
    kind: 'query',
    contextKind: 'authenticated-query',
    async invoke(context: QueryContext, input: z.infer<typeof getUserInputSchema>) {
      const row = await deps.getUserAccess.execute(context, input)
      return row === null ? null : materializeAdminUser(row, await deps.isOidcManagedUser(row.id))
    },
  })

  const searchUsers: IdentityUserOperations['searchUsers'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.search-users.v1',
      summary: 'Search users (public fields only)',
      permissions: ['users:search'],
      inputCodec: zodOperationCodec(
        'identity-access.search-users.input.v1',
        searchUsersInputSchema,
      ),
      outputCodec: zodOperationCodec(
        'identity-access.search-users.output.v1',
        z.array(exactUserPublicSchema),
      ),
    }),
    kind: 'query',
    contextKind: 'authenticated-query',
    async invoke(context: QueryContext, input: z.infer<typeof searchUsersInputSchema>) {
      await deps.getUserAccess.authorize(context, 'users:search')
      return deps.searchUsers(input)
    },
  })

  const lookupUsers: IdentityUserOperations['lookupUsers'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.lookup-users.v1',
      summary: 'Look up users by id (public fields only)',
      permissions: ['users:search'],
      inputCodec: zodOperationCodec(
        'identity-access.lookup-users.input.v1',
        lookupUsersInputSchema,
      ),
      outputCodec: zodOperationCodec(
        'identity-access.lookup-users.output.v1',
        z.array(exactUserPublicSchema),
      ),
    }),
    kind: 'query',
    contextKind: 'authenticated-query',
    async invoke(context: QueryContext, input: z.infer<typeof lookupUsersInputSchema>) {
      await deps.getUserAccess.authorize(context, 'users:search')
      return input.ids.length === 0 ? [] : deps.lookupUsers(input.ids)
    },
  })

  const createUser: IdentityUserOperations['createUser'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.create-user.v1',
      summary: 'Create a user',
      permissions: ['users:write'],
      inputCodec: zodOperationCodec('identity-access.create-user.input.v1', createUserInputSchema),
      outputCodec: zodOperationCodec(
        'identity-access.create-user.output.v1',
        exactAdminUserViewSchema,
      ),
    }),
    kind: 'command',
    contextKind: 'authenticated-command',
    async invoke(context: CommandContext, input: z.infer<typeof createUserInputSchema>) {
      const principal = deps.contexts.resolveCommandContext(context)
      const passwordHash = input.password ? await deps.hashPassword(input.password) : null
      const row = await deps.createManagedUser.execute(context, {
        id: deps.id(),
        username: input.username,
        email: input.email ?? null,
        displayName: input.displayName,
        passwordHash,
        role: input.role,
        status: passwordHash === null ? 'invited' : 'active',
        forcePasswordChange: false,
        createdBy: principal.userId,
        schemaVersion: 1,
        additionalPermissions: input.additionalPermissions,
      })
      return materializeAdminUser(row, false)
    },
  })

  const updateUser: IdentityUserOperations['updateUser'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.update-user.v1',
      summary: 'Update a user',
      permissions: ['users:write'],
      inputCodec: zodOperationCodec('identity-access.update-user.input.v1', updateUserInputSchema),
      outputCodec: zodOperationCodec(
        'identity-access.update-user.output.v1',
        exactAdminUserViewSchema,
      ),
    }),
    kind: 'command',
    contextKind: 'authenticated-command',
    async invoke(context: CommandContext, input: z.infer<typeof updateUserInputSchema>) {
      const result = await deps.updateUserAccess.execute(context, {
        targetUserId: input.targetUserId,
        displayName: input.displayName,
        email: input.email,
        status: input.status,
        forcePasswordChange: input.forcePasswordChange,
        access: input.access,
        legacyRole: input.role,
      })
      if (result.becameDisabled) {
        await deps.afterDisabled({ userId: input.targetUserId, at: context.now })
      }
      return materializeAdminUser(result.user, await deps.isOidcManagedUser(result.user.id))
    },
  })

  const disableUser: IdentityUserOperations['disableUser'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.disable-user.v1',
      summary: 'Delete a user',
      permissions: ['users:write'],
      inputCodec: zodOperationCodec(
        'identity-access.disable-user.input.v1',
        disableUserInputSchema,
      ),
      outputCodec: zodOperationCodec('identity-access.disable-user.output.v1', softDeleteSchema),
    }),
    kind: 'command',
    contextKind: 'authenticated-command',
    async invoke(context: CommandContext, input: z.infer<typeof disableUserInputSchema>) {
      const result = await deps.updateUserAccess.execute(context, {
        targetUserId: input.targetUserId,
        status: 'disabled',
      })
      if (result.becameDisabled) {
        await deps.afterDisabled({ userId: input.targetUserId, at: context.now })
      }
      return { ok: true, code: 'user-deletion-soft' } as const
    },
  })

  const resetPassword: IdentityUserOperations['resetPassword'] = Object.freeze({
    ...descriptorBase({
      id: 'identity-access.reset-user-password.v1',
      summary: 'Reset a local password',
      permissions: ['users:write'],
      inputCodec: zodOperationCodec(
        'identity-access.reset-user-password.input.v1',
        resetPasswordInputSchema,
      ),
      outputCodec: zodOperationCodec('identity-access.reset-user-password.output.v1', okSchema),
    }),
    kind: 'command',
    contextKind: 'authenticated-command',
    async invoke(_context: CommandContext, input: z.infer<typeof resetPasswordInputSchema>) {
      await deps.resetPassword({
        userId: input.targetUserId,
        newPassword: input.newPassword,
        force: input.force,
      })
      return { ok: true } as const
    },
  })

  return Object.freeze({
    listUsers,
    getUser,
    searchUsers,
    lookupUsers,
    createUser,
    updateUser,
    disableUser,
    resetPassword,
  })
}
