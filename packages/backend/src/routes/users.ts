// RFC-036 — admin users management routes + public users:search endpoint.

import type { Hono } from 'hono'
import {
  CreateUserBodySchema,
  PatchUserBodySchema,
  ResetPasswordBodySchema,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { requirePermission } from '@/auth/permissions'
import type { AppDeps } from '@/server'
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

export function mountUserRoutes(app: Hono, deps: AppDeps): void {
  // /api/users/search — admin + user (users:search permission). MUST come
  // before /api/users so the literal wins over the catch-all admin gate.
  app.get('/api/users/search', requirePermission('users:search'), async (c) => {
    const q = c.req.query('q') ?? undefined
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? '20'), 1), 100)
    const excludeIds = (c.req.query('excludeIds') ?? '').split(',').filter(Boolean)
    const rows = await searchUsersPublic(deps.db, { q, limit, excludeIds })
    return c.json(rows)
  })

  // RFC-099 — batch id → public-fields resolve for attribution chips
  // (review comments / clarify per-question editors / owner badges). Same
  // users:search permission class as the picker: public fields only, never
  // emails. Unknown ids are silently dropped so callers can blind-resolve.
  app.post('/api/users/lookup', requirePermission('users:search'), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown }
    const ids = Array.isArray(body.ids)
      ? body.ids.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, 200)
      : []
    if (ids.length === 0) return c.json([])
    const { lookupUsersPublic } = await import('@/services/users')
    return c.json(await lookupUsersPublic(deps.db, ids))
  })

  // Everything below is admin-only.
  app.get('/api/users', requirePermission('users:read'), async (c) => {
    const rows = await listAllUsers(deps.db)
    const managed = await listOidcManagedUserIds(
      deps.db,
      rows.map((row) => row.id),
    )
    return c.json(rows.map((row) => materializePublicAdminView(row, managed.has(row.id))))
  })

  app.get('/api/users/:id', requirePermission('users:read'), async (c) => {
    const u = await findById(deps.db, c.req.param('id'))
    if (!u) throw new NotFoundError('user-not-found', `user '${c.req.param('id')}' not found`)
    return c.json(materializePublicAdminView(u, await isOidcManagedUser(deps.db, u.id)))
  })

  app.post('/api/users', requirePermission('users:write'), async (c) => {
    const parsed = CreateUserBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('user-invalid', 'invalid user payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const created = await createUser(deps.db, { ...parsed.data, createdBy: actor.user.id })
    return c.json(materializePublicAdminView(created, false), 201)
  })

  app.patch('/api/users/:id', requirePermission('users:write'), async (c) => {
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
    return c.json(materializePublicAdminView(updated, await isOidcManagedUser(deps.db, updated.id)))
  })

  app.delete('/api/users/:id', requirePermission('users:write'), async (c) => {
    await disableUser(deps.db, c.req.param('id'), Date.now(), actorOf(c).user.id)
    return c.json({ ok: true, code: 'user-deletion-soft' })
  })

  app.post('/api/users/:id/reset-password', requirePermission('users:write'), async (c) => {
    const parsed = ResetPasswordBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('reset-invalid', 'invalid reset-password body', {
        issues: parsed.error.issues,
      })
    }
    await resetPassword(deps.db, c.req.param('id'), parsed.data)
    return c.json({ ok: true })
  })
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
