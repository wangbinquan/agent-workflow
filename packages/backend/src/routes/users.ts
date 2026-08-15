// RFC-036/RFC-305 — permission-gated user management routes plus the
// public-fields-only `users:search` endpoint.

import type { Hono } from 'hono'
import { ulid } from 'ulid'
import {
  CreateUserBodySchema,
  PatchUserBodySchema,
  ResetPasswordBodySchema,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { hashPassword } from '@/auth/passwords'
import { revokeAllSessionsForUser } from '@/auth/sessionStore'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { listAllPats } from '@/auth/patStore'
import { listTokenAudit } from '@/services/tokenAudit'
import { resetPassword, searchUsersPublic } from '@/services/users'
import { isOidcManagedUser, listOidcManagedUserIds } from '@/services/accountAuthPolicy'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { getMcpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { Paths } from '@/util/paths'
import { safeJsonOrEmpty } from '@/util/http'
import type { CreateManagedUser, UpdateUserAccess } from '@/modules/identity-access/public/commands'
import type { DirectOperationContextFactory } from '@/modules/identity-access/public/participants'
import type { GetUserAccess } from '@/modules/identity-access/public/queries'
import { UserAccessError, type AdminUserAccessView } from '@/modules/identity-access/public/types'

interface UserRouteIdentityAccess {
  readonly contexts: DirectOperationContextFactory
  readonly createManagedUser: CreateManagedUser
  readonly updateUserAccess: UpdateUserAccess
  readonly getUserAccess: GetUserAccess
}

export function mountUserRoutes(
  app: Hono,
  deps: AppDeps,
  identityAccess: UserRouteIdentityAccess,
): void {
  const runtimeTests = getMcpRuntimeTestService({
    db: deps.db,
    configPath: deps.configPath,
    appHome: deps.mcpRuntimeTestDependencies?.appHome ?? Paths.root,
    runFn: deps.mcpRuntimeTestDependencies?.runFn,
    now: deps.mcpRuntimeTestDependencies?.now,
    capacity: deps.mcpRuntimeTestDependencies?.capacity,
  })
  // /api/users/search — `users:search`. MUST come before /api/users so the
  // literal wins over the parameterized route.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/users/search',
      permissions: ['users:search'],
      tokenAccess: 'allow',
      summary: 'Search users (public fields only)',
    },
    async (c) => {
      const q = c.req.query('q') ?? undefined
      const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '20'), 1), 100)
      const excludeIds = (c.req.query('excludeIds') ?? '').split(',').filter(Boolean)
      const status = c.req.query('status')
      if (status !== undefined && !['active', 'disabled', 'invited'].includes(status)) {
        throw new ValidationError('user-invalid', `unknown user status '${status}'`)
      }
      const rows = await searchUsersPublic(deps.db, {
        q,
        limit,
        excludeIds,
        status: status as 'active' | 'disabled' | 'invited' | undefined,
      })
      return c.json(rows)
    },
  )

  // RFC-099 — batch id → public-fields resolve for attribution chips
  // (review comments / clarify per-question editors / owner badges). Same
  // users:search permission class as the picker: public fields only, never
  // emails. Unknown ids are silently dropped so callers can blind-resolve.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/users/lookup',
      permissions: ['users:search'],
      tokenAccess: 'allow',
      summary: 'Look up users by id (public fields only)',
    },
    async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 200)
        : []
      if (ids.length === 0) return c.json([])
      const { lookupUsersPublic } = await import('@/services/users')
      return c.json(await lookupUsersPublic(deps.db, ids))
    },
  )

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
      return c.json(await listTokenAudit(deps.db))
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
      return c.json(await listAllPats(deps.db))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/users',
      permissions: ['users:read'],
      tokenAccess: 'allow',
      summary: 'List users',
    },
    async (c) => {
      const actor = actorOf(c)
      const context = identityAccess.contexts.queryFromAuthenticatedPrincipal(
        { userId: actor.user.id, source: actor.source },
        'http',
      )
      const rows = await accessCall(() => identityAccess.getUserAccess.list(context))
      const managed = await listOidcManagedUserIds(
        deps.db,
        rows.map((row) => row.id),
      )
      return c.json(rows.map((row) => materializePublicAdminView(row, managed.has(row.id))))
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/users/:id',
      permissions: ['users:read'],
      tokenAccess: 'allow',
      summary: 'Get one user',
    },
    async (c) => {
      const actor = actorOf(c)
      const context = identityAccess.contexts.queryFromAuthenticatedPrincipal(
        { userId: actor.user.id, source: actor.source },
        'http',
      )
      const u = await accessCall(() =>
        identityAccess.getUserAccess.execute(context, { userId: c.req.param('id') }),
      )
      if (!u) throw new NotFoundError('user-not-found', `user '${c.req.param('id')}' not found`)
      return c.json(materializePublicAdminView(u, await isOidcManagedUser(deps.db, u.id)))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/users',
      permissions: ['users:write'],
      tokenAccess: 'allow',
      summary: 'Create a user',
    },
    async (c) => {
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
      const actor = actorOf(c)
      const now = Date.now()
      const context = identityAccess.contexts.fromAuthenticatedPrincipal(
        { userId: actor.user.id, source: actor.source },
        'http',
        now,
      )
      const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : null
      const created = await accessCall(() =>
        identityAccess.createManagedUser.execute(context, {
          id: ulid(),
          username: parsed.data.username,
          email: parsed.data.email ?? null,
          displayName: parsed.data.displayName,
          passwordHash,
          role: parsed.data.role,
          status: passwordHash === null ? 'invited' : 'active',
          forcePasswordChange: false,
          createdBy: actor.user.id,
          schemaVersion: 1,
          additionalPermissions: parsed.data.additionalPermissions,
        }),
      )
      return c.json(materializePublicAdminView(created, false), 201)
    },
  )

  registerRoute(
    app,
    {
      method: 'PATCH',
      path: '/api/users/:id',
      permissions: ['users:write'],
      tokenAccess: 'allow',
      summary: 'Update a user',
    },
    async (c) => {
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
      const actor = actorOf(c)
      const now = Date.now()
      const context = identityAccess.contexts.fromAuthenticatedPrincipal(
        { userId: actor.user.id, source: actor.source },
        'http',
        now,
      )
      const result = await accessCall(() =>
        identityAccess.updateUserAccess.execute(context, {
          targetUserId: c.req.param('id'),
          displayName: parsed.data.displayName,
          email: parsed.data.email,
          status: parsed.data.status,
          forcePasswordChange: parsed.data.forcePasswordChange,
          access: parsed.data.access,
          legacyRole: parsed.data.role,
        }),
      )
      if (result.becameDisabled) {
        await revokeAllSessionsForUser(deps.db, c.req.param('id'), now)
        await runtimeTests.reconcileDurableIntents()
      }
      return c.json(
        materializePublicAdminView(result.user, await isOidcManagedUser(deps.db, result.user.id)),
      )
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/users/:id',
      permissions: ['users:write'],
      tokenAccess: 'allow',
      summary: 'Delete a user',
    },
    async (c) => {
      const userId = c.req.param('id')
      const actor = actorOf(c)
      const now = Date.now()
      const context = identityAccess.contexts.fromAuthenticatedPrincipal(
        { userId: actor.user.id, source: actor.source },
        'http',
        now,
      )
      const result = await accessCall(() =>
        identityAccess.updateUserAccess.execute(context, {
          targetUserId: userId,
          status: 'disabled',
        }),
      )
      if (result.becameDisabled) {
        await revokeAllSessionsForUser(deps.db, userId, now)
        await runtimeTests.reconcileDurableIntents()
      }
      return c.json({ ok: true, code: 'user-deletion-soft' })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/users/:id/reset-password',
      permissions: ['users:write'],
      tokenAccess: 'allow',
      summary: 'Reset a local password',
    },
    async (c) => {
      const parsed = ResetPasswordBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('reset-invalid', 'invalid reset-password body', {
          issues: parsed.error.issues,
        })
      }
      await resetPassword(deps.db, c.req.param('id'), parsed.data)
      return c.json({ ok: true })
    },
  )
}

function materializePublicAdminView(row: AdminUserAccessView, hasOidcIdentity: boolean) {
  return {
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
  }
}

async function accessCall<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
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
