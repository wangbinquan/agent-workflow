// RFC-036 — user-scoped auth endpoints (login / logout / me / change-password
// / sessions / pats / identities). All but login require an active session
// + the `account:self` permission (granted to both roles).

import { and, eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import {
  ChangePasswordBodySchema,
  CreatePatBodySchema,
  LoginBodySchema,
  SESSION_TOKEN_PREFIX,
  type Permission,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { hashPassword, verifyPassword, verifyPasswordDummy } from '@/auth/passwords'
import { requirePermission } from '@/auth/permissions'
import { createPat, listPatsForUser, revokePat } from '@/auth/patStore'
import {
  createSession,
  hashToken,
  listActiveSessionsForUser,
  revokeAllSessionsForUser,
  revokeSession,
} from '@/auth/sessionStore'
import { userPats, users, userSessions } from '@/db/schema'
import { deleteIdentity, listIdentitiesForUser } from '@/services/userIdentities'
import type { AppDeps } from '@/server'
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@/util/errors'

export function mountAuthRoutes(app: Hono, deps: AppDeps): void {
  // Public — uses username + password, no session required.
  app.post('/api/auth/login', async (c) => {
    const parsed = LoginBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('login-invalid', 'invalid login payload')
    }
    const { username, password } = parsed.data
    const rows = await deps.db.select().from(users).where(eq(users.username, username)).limit(1)
    const row = rows[0]
    if (!row || row.status !== 'active' || !row.passwordHash) {
      // RFC-103 T9: run a real argon2 verify against a dummy hash so timing does
      // not distinguish "no user / inactive / no passwordHash" from a wrong
      // password (the comment used to claim constant-time but skipped argon2).
      await verifyPasswordDummy(password)
      throw new UnauthorizedError('invalid username or password')
    }
    const ok = await verifyPassword(password, row.passwordHash)
    if (!ok) throw new UnauthorizedError('invalid username or password')
    const userAgent = c.req.header('user-agent') ?? null
    const { token } = await createSession({ db: deps.db, userId: row.id, userAgent })
    await deps.db.update(users).set({ lastLoginAt: Date.now() }).where(eq(users.id, row.id))
    return c.json({
      sessionToken: token,
      user: {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        role: row.role,
        status: row.status,
      },
      mustChangePassword: row.forcePasswordChange,
    })
  })

  // From here on, account:self required (admin + user both have it).
  app.post('/api/auth/logout', requirePermission('account:self'), async (c) => {
    const token = extractRawToken(c)
    if (token && token.startsWith(SESSION_TOKEN_PREFIX)) {
      const hash = hashToken(token)
      const rows = await deps.db
        .select()
        .from(userSessions)
        .where(eq(userSessions.tokenHash, hash))
        .limit(1)
      if (rows[0]) await revokeSession(deps.db, rows[0].id)
    }
    return c.body(null, 204)
  })

  app.get('/api/auth/me', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    const identities = await listIdentitiesForUser(deps.db, actor.user.id)
    const pats = await listPatsForUser(deps.db, actor.user.id)
    return c.json({
      user: actor.user,
      source: actor.source,
      permissions: [...actor.permissions],
      linkedIdentities: identities,
      pats,
    })
  })

  app.post('/api/auth/change-password', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    const parsed = ChangePasswordBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) throw new ValidationError('change-password-invalid', 'invalid payload')

    const rows = await deps.db.select().from(users).where(eq(users.id, actor.user.id)).limit(1)
    const row = rows[0]
    if (!row) throw new NotFoundError('user-not-found', 'user not found')

    if (!row.forcePasswordChange) {
      if (!parsed.data.oldPassword) {
        throw new ValidationError('old-password-required', 'oldPassword is required')
      }
      if (!row.passwordHash || !(await verifyPassword(parsed.data.oldPassword, row.passwordHash))) {
        throw new ForbiddenError('old-password-mismatch', 'incorrect old password')
      }
    }
    const newHash = await hashPassword(parsed.data.newPassword)
    await deps.db
      .update(users)
      .set({ passwordHash: newHash, forcePasswordChange: false, updatedAt: Date.now() })
      .where(eq(users.id, actor.user.id))

    // Revoke every other session for this user; keep the current one.
    const currentToken = extractRawToken(c)
    const currentHash = currentToken ? hashToken(currentToken) : null
    await revokeAllSessionsForUser(deps.db, actor.user.id)
    if (currentHash) {
      // Mint a fresh session for the caller so the response can include it.
      const { token } = await createSession({
        db: deps.db,
        userId: actor.user.id,
        userAgent: c.req.header('user-agent') ?? null,
      })
      return c.json({ ok: true, sessionToken: token })
    }
    return c.json({ ok: true })
  })

  app.get('/api/auth/sessions', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    return c.json(await listActiveSessionsForUser(deps.db, actor.user.id))
  })

  app.post('/api/auth/sessions/:id/revoke', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    const rows = await deps.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, c.req.param('id')))
      .limit(1)
    const row = rows[0]
    // Unknown id and someone-else's id答 the SAME 403 — answering 404 for the
    // former turned this endpoint into an existence oracle: a logged-in user
    // could probe which session ids are live simply by watching the status
    // change. The two sibling endpoints below (PATs, identities) already
    // collapse both cases, and RFC-099's rule for resources is likewise
    // "indistinguishable from not-found". Locked by
    // tests/auth-self-service-idor.test.ts.
    // See design/test-guard-audit-2026-07-21 §1 (B1-routes-1).
    if (!row || row.userId !== actor.user.id)
      throw new ForbiddenError('forbidden', 'session does not belong to current user')
    await revokeSession(deps.db, row.id)
    return c.body(null, 204)
  })

  app.get('/api/auth/pats', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    return c.json(await listPatsForUser(deps.db, actor.user.id))
  })

  app.post('/api/auth/pats', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    const parsed = CreatePatBodySchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) throw new ValidationError('pat-invalid', 'invalid PAT payload')
    const scopes = (parsed.data.scopes ?? []).filter((s) => actor.permissions.has(s as Permission))
    const { token, meta } = await createPat({
      db: deps.db,
      userId: actor.user.id,
      name: parsed.data.name,
      scopes,
      expiresAt: parsed.data.expiresAt ?? null,
    })
    return c.json({ token, ...meta }, 201)
  })

  app.delete('/api/auth/pats/:id', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    const id = c.req.param('id')
    const rows = await deps.db
      .select()
      .from(userPats)
      .where(and(eq(userPats.id, id), eq(userPats.userId, actor.user.id)))
      .limit(1)
    if (!rows[0]) {
      throw new ForbiddenError('forbidden', 'PAT does not belong to current user')
    }
    await revokePat(deps.db, id)
    return c.body(null, 204)
  })

  app.get('/api/auth/identities', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    return c.json(await listIdentitiesForUser(deps.db, actor.user.id))
  })

  app.delete('/api/auth/identities/:id', requirePermission('account:self'), async (c) => {
    const actor = actorOf(c)
    const id = c.req.param('id')
    const list = await listIdentitiesForUser(deps.db, actor.user.id)
    if (!list.some((r) => r.id === id)) {
      throw new ForbiddenError('forbidden', 'identity does not belong to current user')
    }
    await deleteIdentity(deps.db, id)
    return c.body(null, 204)
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}

function extractRawToken(c: Context): string | null {
  const query = c.req.query('token')
  if (query && query.length > 0) return query
  const header = c.req.header('Authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S+)\s*$/i)
  return match && match[1] ? match[1] : null
}
