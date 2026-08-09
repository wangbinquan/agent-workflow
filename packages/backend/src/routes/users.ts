// RFC-036 — admin users management routes + public users:search endpoint.

import type { Hono } from 'hono'
import {
  CreateUserBodySchema,
  PatchUserBodySchema,
  ResetPasswordBodySchema,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { listAllPats } from '@/auth/patStore'
import { listTokenAudit } from '@/services/tokenAudit'
import {
  createUser,
  disableUser,
  findById,
  listAllUsers,
  patchUser,
  resetPassword,
  searchUsersPublic,
} from '@/services/users'
import { isOidcManagedUser, listOidcManagedUserIds } from '@/services/accountAuthPolicy'
import { NotFoundError, ValidationError } from '@/util/errors'
import { getMcpRuntimeTestService } from '@/services/mcpRuntimeTest'
import { Paths } from '@/util/paths'

export function mountUserRoutes(app: Hono, deps: AppDeps): void {
  const runtimeTests = getMcpRuntimeTestService({
    db: deps.db,
    configPath: deps.configPath,
    appHome: deps.mcpRuntimeTestDependencies?.appHome ?? Paths.root,
    containmentCoordinator: deps.containmentCoordinator,
    runFn: deps.mcpRuntimeTestDependencies?.runFn,
    now: deps.mcpRuntimeTestDependencies?.now,
    capacity: deps.mcpRuntimeTestDependencies?.capacity,
  })
  // /api/users/search — admin + user (users:search permission). MUST come
  // before /api/users so the literal wins over the catch-all admin gate.
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

  // Everything below is admin-only.
  // RFC-247 D8 / D16 / T27 — the administrator's platform-wide token view.
  // READ-ONLY on purpose: an admin can see every token and every call made with
  // one, and cannot revoke someone else's. Revocation stays with the owner
  // because a token is a credential the owner is accountable for; the lever an
  // admin has for a compromised account is disabling the account, which revokes
  // everything at once and is the honest action to take.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/tokens/audit',
      permissions: ['users:read'],
      identity: 'admin',
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
      identity: 'admin',
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
      const rows = await listAllUsers(deps.db)
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
      const u = await findById(deps.db, c.req.param('id'))
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
      const parsed = CreateUserBodySchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('user-invalid', 'invalid user payload', {
          issues: parsed.error.issues,
        })
      }
      const actor = actorOf(c)
      const created = await createUser(deps.db, { ...parsed.data, createdBy: actor.user.id })
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
      const parsed = PatchUserBodySchema.safeParse(await safeJson(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('user-invalid', 'invalid user patch', {
          issues: parsed.error.issues,
        })
      }
      const updated = await patchUser(
        deps.db,
        c.req.param('id'),
        parsed.data,
        Date.now(),
        actorOf(c).user.id,
      )
      if (parsed.data.status === 'disabled') await runtimeTests.reconcileDurableIntents()
      return c.json(
        materializePublicAdminView(updated, await isOidcManagedUser(deps.db, updated.id)),
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
      await disableUser(deps.db, userId, Date.now(), actorOf(c).user.id)
      await runtimeTests.reconcileDurableIntents()
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
      const parsed = ResetPasswordBodySchema.safeParse(await safeJson(c.req.raw))
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

function materializePublicAdminView(
  row: {
    id: string
    username: string
    email: string | null
    displayName: string
    role: string
    status: string
    forcePasswordChange: boolean
    createdBy: string | null
    createdAt: number
    updatedAt: number
    lastLoginAt: number | null
  },
  hasOidcIdentity: boolean,
) {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    forcePasswordChange: row.forcePasswordChange,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt,
    hasOidcIdentity,
  }
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
