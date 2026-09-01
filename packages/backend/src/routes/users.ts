// RFC-036/RFC-305 — permission-gated user management routes plus the
// public-fields-only `users:search` endpoint.

import type { Hono } from 'hono'
import {
  CreateUserBodySchema,
  PatchUserBodySchema,
  ResetPasswordBodySchema,
} from '@agent-workflow/shared'
import type { TokenAuditView } from '@/routes/auth'
import { actorOf, type Actor } from '@/auth/actor'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import { registerRoute } from '@/routes/registry'
import { registerOperationRoute } from '@/routes/operationRoute'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'
import type {
  DirectAuthorityBinding,
  DirectCommandContextFactory,
  DirectQueryContextFactory,
} from '@/modules/identity-access/public/participants'
import type { IdentityUserOperations } from '@/modules/identity-access/public/operations'
import { UserAccessError } from '@/modules/identity-access/public/types'
import { directRequestAuthority } from '@/routes/operationAuthority'

interface UserRouteIdentityAccess {
  readonly contexts: DirectCommandContextFactory & DirectQueryContextFactory
  readonly directAuthority: DirectAuthorityBinding
  readonly operations: IdentityUserOperations
}

export interface UserRouteAuthBindings {
  readonly auth: AuthRuntime
  readonly listTokenAudit: () => Promise<ReadonlyArray<TokenAuditView>>
}

export function mountUserRoutes(
  app: Hono,
  deps: UserRouteAuthBindings,
  identityAccess: UserRouteIdentityAccess,
): void {
  // /api/users/search — `users:search`. MUST come before /api/users so the
  // literal wins over the parameterized route.
  registerOperationRoute(app, {
    descriptor: identityAccess.operations.searchUsers,
    method: 'GET',
    path: '/api/users/search',
    tokenAccess: 'allow',
    decode: (c) => {
      const status = c.req.query('status')
      if (status !== undefined && !['active', 'disabled', 'invited'].includes(status)) {
        throw new ValidationError('user-invalid', `unknown user status '${status}'`)
      }
      return {
        q: c.req.query('q') ?? undefined,
        limit: Math.min(Math.max(Number(c.req.query('limit') ?? '20'), 1), 100),
        excludeIds: (c.req.query('excludeIds') ?? '').split(',').filter(Boolean),
        status,
      }
    },
    context: (c) => queryContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
    mapError: mapUserAccessError,
  })

  // RFC-099 — batch id → public-fields resolve for attribution chips
  // (review comments / clarify per-question editors / owner badges). Same
  // users:search permission class as the picker: public fields only, never
  // emails. Unknown ids are silently dropped so callers can blind-resolve.
  registerOperationRoute(app, {
    descriptor: identityAccess.operations.lookupUsers,
    method: 'POST',
    path: '/api/users/lookup',
    tokenAccess: 'allow',
    decode: async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 200)
        : []
      return { ids }
    },
    context: (c) => queryContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
    mapError: mapUserAccessError,
  })

  // RFC-247 D8 / D16 / T27 — the `users:read` platform-wide token view.
  // READ-ONLY on purpose: an authorized actor can see every token and every call made with
  // one, and cannot revoke someone else's. Revocation stays with the owner
  // because a token is a credential the owner is accountable for; the lever an
  // `users:write` holder has for a compromised account is disabling the account, which revokes
  // everything at once and is the honest action to take.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tokens/audit',
      permissions: ['users:read'],
      tokenAccess: 'never',
      summary: 'Platform-wide token call audit (read-only)',
    },
    async (c) => {
      return c.json(await deps.listTokenAudit())
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tokens',
      permissions: ['users:read'],
      tokenAccess: 'never',
      summary: 'Platform-wide token inventory (read-only)',
    },
    async (c) => {
      return c.json(await deps.auth.listAllPats())
    },
  )

  registerOperationRoute(app, {
    descriptor: identityAccess.operations.listUsers,
    method: 'GET',
    path: '/api/users',
    tokenAccess: 'allow',
    decode: () => ({}),
    context: (c) => queryContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
    mapError: mapUserAccessError,
  })

  registerOperationRoute(app, {
    descriptor: identityAccess.operations.getUser,
    method: 'GET',
    path: '/api/users/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ userId: c.req.param('id') }),
    context: (c) => queryContext(identityAccess, actorOf(c)),
    encode: (c, output) => {
      if (output === null) {
        throw new NotFoundError('user-not-found', `user '${c.req.param('id')}' not found`)
      }
      return c.json(output)
    },
    mapError: mapUserAccessError,
  })

  registerOperationRoute(app, {
    descriptor: identityAccess.operations.createUser,
    method: 'POST',
    path: '/api/users',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = CreateUserBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError(
          userPayloadValidationCode(parsed.error.issues),
          'invalid user payload',
          {
            issues: parsed.error.issues,
          },
        )
      }
      return parsed.data
    },
    context: (c) => commandContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output, 201),
    mapError: mapUserAccessError,
  })

  registerOperationRoute(app, {
    descriptor: identityAccess.operations.updateUser,
    method: 'PATCH',
    path: '/api/users/:id',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = PatchUserBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError(
          userPayloadValidationCode(parsed.error.issues),
          'invalid user patch',
          {
            issues: parsed.error.issues,
          },
        )
      }
      return { targetUserId: c.req.param('id'), ...parsed.data }
    },
    context: (c) => commandContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
    mapError: mapUserAccessError,
  })

  registerOperationRoute(app, {
    descriptor: identityAccess.operations.disableUser,
    method: 'DELETE',
    path: '/api/users/:id',
    tokenAccess: 'allow',
    decode: (c) => ({ targetUserId: c.req.param('id') }),
    context: (c) => commandContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
    mapError: mapUserAccessError,
  })

  registerOperationRoute(app, {
    descriptor: identityAccess.operations.resetPassword,
    method: 'POST',
    path: '/api/users/:id/reset-password',
    tokenAccess: 'allow',
    decode: async (c) => {
      const parsed = ResetPasswordBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('reset-invalid', 'invalid reset-password body', {
          issues: parsed.error.issues,
        })
      }
      return { targetUserId: c.req.param('id'), ...parsed.data }
    },
    context: (c) => commandContext(identityAccess, actorOf(c)),
    encode: (c, output) => c.json(output),
    mapError: mapUserAccessError,
  })
}

function queryContext(factory: UserRouteIdentityAccess, actor: Actor) {
  return factory.contexts.queryFromAuthority(
    directRequestAuthority(factory.directAuthority, actor),
    'http',
  )
}

function commandContext(factory: UserRouteIdentityAccess, actor: Actor) {
  return factory.contexts.fromAuthority(
    directRequestAuthority(factory.directAuthority, actor),
    'http',
  )
}

function mapUserAccessError(error: unknown): never {
  if (!(error instanceof UserAccessError)) throw error
  switch (error.kind) {
    case 'conflict':
      throw new ConflictError(error.code, error.message, error.details)
    case 'forbidden':
      throw new ForbiddenError(error.code, error.message, error.details)
    case 'not-found':
      throw new NotFoundError(error.code, error.message, error.details)
    case 'validation':
      throw new ValidationError(error.code, error.message, error.details)
  }
}

function userPayloadValidationCode(
  issues: ReadonlyArray<{
    readonly path: ReadonlyArray<PropertyKey>
    readonly message: string
  }>,
): string {
  if (issues.some((issue) => issue.message === 'user-access-ambiguous')) {
    return 'user-access-ambiguous'
  }
  if (
    issues.some(
      (issue) =>
        issue.path[0] === 'additionalPermissions' ||
        (issue.path[0] === 'access' && issue.path[1] === 'additionalPermissions'),
    )
  ) {
    return 'user-permission-invalid'
  }
  return 'user-invalid'
}
