// RFC-036 — user-scoped auth endpoints (login / logout / me / change-password
// / sessions / pats / identities). All but login require an active session
// + the `account:self` permission (granted to both roles).

import { and, eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import {
  CreatePatBodySchema,
  ChangePasswordBodySchema,
  CreateBootstrapAdminBodySchema,
  LoginBodySchema,
  SESSION_TOKEN_PREFIX,
} from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
// RFC-285 B4：本文件原有一份同名 extractRawToken 私有副本（第二读点，含
// ?token= query 支持）——收编进 auth/session 的共享 REST 入口，query 面退役。
import { extractBearerToken } from '@/auth/session'
import { hashPassword, verifyPassword, verifyPasswordDummy } from '@/auth/passwords'
import { isMcpSurfaceEnabled } from '@/services/mcpSurface'
import {
  assertMatrixGrantable,
  createPat,
  listPatsForUser,
  PatMatrixError,
  revokePat,
} from '@/auth/patStore'
import {
  createSession,
  hashToken,
  listActiveSessionsForUser,
  revokeAllSessionsForUser,
  revokeSession,
} from '@/auth/sessionStore'
import { userPats, users, userSessions } from '@/db/schema'
import { listIdentitiesForUser } from '@/services/userIdentities'
import { isOidcManagedUser, writeLocalPasswordIfUnmanaged } from '@/services/accountAuthPolicy'
import {
  assertBootstrapComplete,
  completeBootstrapWithAdmin,
  createPasswordLoginSession,
  getAuthLoginPolicy,
} from '@/auth/loginPolicy'
import type { AppDeps } from '@/server'
import { registerRoute } from '@/routes/registry'
import { listTokenAuditForUser } from '@/services/tokenAudit'
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from '@/util/errors'
import { safeJsonOrEmpty } from '@/util/http'

export function mountAuthRoutes(app: Hono, deps: AppDeps): void {
  // Public — uses username + password, no session required.
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/login',
      permissions: [],
      publicReason:
        'login flow; must answer before any identity exists (already in multiAuth PUBLIC_PATH_PREFIXES)',
      tokenAccess: 'never',
      summary: 'Password login',
    },
    async (c) => {
      const policy = assertBootstrapComplete(deps.db)
      if (!policy.passwordLoginEnabled) {
        throw new ForbiddenError(
          'password-login-disabled',
          'username and password login is disabled',
        )
      }
      const parsed = LoginBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
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
      const { token, user } = createPasswordLoginSession(deps.db, {
        userId: row.id,
        verifiedPasswordHash: row.passwordHash,
        userAgent: c.req.header('user-agent') ?? null,
      })
      return c.json({
        sessionToken: token,
        user: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          role: user.role,
          status: user.status,
        },
        mustChangePassword: user.forcePasswordChange,
      })
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/bootstrap/status',
      permissions: [],
      publicReason: 'bootstrap gate; answers before the first administrator exists',
      tokenAccess: 'never',
      summary: 'Whether the first administrator still needs creating',
    },
    async (c) => {
      if (actorOf(c).source !== 'daemon') {
        throw new ForbiddenError('bootstrap-daemon-required', 'daemon bootstrap token required')
      }
      return c.json({ required: getAuthLoginPolicy(deps.db).bootstrapCompletedAt === null })
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/bootstrap/admin',
      permissions: [],
      publicReason: 'bootstrap gate; answers before the first administrator exists',
      tokenAccess: 'never',
      summary: 'Create the first administrator',
    },
    async (c) => {
      if (actorOf(c).source !== 'daemon') {
        throw new ForbiddenError('bootstrap-daemon-required', 'daemon bootstrap token required')
      }
      const parsed = CreateBootstrapAdminBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('bootstrap-admin-invalid', 'invalid bootstrap administrator', {
          issues: parsed.error.issues,
        })
      }
      const passwordHash = await hashPassword(parsed.data.password)
      const created = completeBootstrapWithAdmin(deps.db, {
        username: parsed.data.username,
        displayName: parsed.data.displayName,
        ...(parsed.data.email !== undefined ? { email: parsed.data.email } : {}),
        passwordHash,
      })
      return c.json(
        {
          id: created.id,
          username: created.username,
          email: created.email,
          displayName: created.displayName,
          role: created.role,
          status: created.status,
          forcePasswordChange: created.forcePasswordChange,
          createdBy: created.createdBy,
          createdAt: created.createdAt,
          updatedAt: created.updatedAt,
          lastLoginAt: created.lastLoginAt,
          hasOidcIdentity: false,
        },
        201,
      )
    },
  )

  // From here on, account:self required (admin + user both have it).
  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/logout',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Log out the current session',
    },
    async (c) => {
      const token = extractBearerToken(c)
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
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/me',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Current actor, sessions, PATs and identities',
    },
    async (c) => {
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
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/change-password',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Change the local password',
    },
    async (c) => {
      const actor = actorOf(c)
      if (await isOidcManagedUser(deps.db, actor.user.id)) {
        throw new ForbiddenError(
          'oidc-password-managed',
          'password is managed by the linked identity provider',
        )
      }
      const parsed = ChangePasswordBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) throw new ValidationError('change-password-invalid', 'invalid payload')

      const rows = await deps.db.select().from(users).where(eq(users.id, actor.user.id)).limit(1)
      const row = rows[0]
      if (!row) throw new NotFoundError('user-not-found', 'user not found')

      if (!row.forcePasswordChange) {
        if (!parsed.data.oldPassword) {
          throw new ValidationError('old-password-required', 'oldPassword is required')
        }
        if (
          !row.passwordHash ||
          !(await verifyPassword(parsed.data.oldPassword, row.passwordHash))
        ) {
          throw new ForbiddenError('old-password-mismatch', 'incorrect old password')
        }
      }
      const newHash = await hashPassword(parsed.data.newPassword)
      writeLocalPasswordIfUnmanaged(deps.db, {
        userId: actor.user.id,
        passwordHash: newHash,
        forcePasswordChange: false,
        activate: false,
        updatedAt: Date.now(),
      })

      // Revoke every other session for this user; keep the current one.
      const currentToken = extractBearerToken(c)
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
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/sessions',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'List own sessions',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await listActiveSessionsForUser(deps.db, actor.user.id))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/sessions/:id/revoke',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Revoke one of own sessions',
    },
    async (c) => {
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
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/pats',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'List own personal access tokens',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await listPatsForUser(deps.db, actor.user.id))
    },
  )

  registerRoute(
    app,
    {
      method: 'POST',
      path: '/api/auth/pats',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Create a personal access token',
    },
    async (c) => {
      // RFC-247 D1 — reopened. RFC-221 D1 closed this globally ("只退不进")
      // because there was no way to issue a NARROW token: the permission
      // catalog only had `资源:write`, so any token that could edit could also
      // delete, and an empty scope list silently meant "everything the owner
      // has". RFC-247 fixed both, which is what makes issuing safe again.
      const actor = actorOf(c)
      if (!isMcpSurfaceEnabled(deps.configPath)) {
        throw new ForbiddenError(
          'token-issuance-disabled',
          'the administrator has disabled the API token surface',
        )
      }
      const parsed = CreatePatBodySchema.safeParse(await safeJsonOrEmpty(c.req.raw))
      if (!parsed.success) {
        throw new ValidationError('pat-invalid', 'invalid token payload', {
          issues: parsed.error.issues,
        })
      }
      // AC-7 — refuse an over-reaching matrix rather than silently narrowing it.
      // resolveTokenPermissions would drop the extra points anyway, but a user
      // who walks away believing they issued a token that can create repos, and
      // discovers otherwise when their automation 403s hours later, was failed
      // at exactly this line.
      try {
        assertMatrixGrantable(actor.permissions, parsed.data.scopes)
      } catch (err) {
        if (err instanceof PatMatrixError) {
          throw new ValidationError(
            'pat-scope-ungrantable',
            'your account cannot grant some of the selected permissions',
            { ungrantable: err.ungrantable },
          )
        }
        throw err
      }
      const created = await createPat({
        db: deps.db,
        userId: actor.user.id,
        name: parsed.data.name,
        scopes: parsed.data.scopes,
        purpose: parsed.data.purpose,
        expiresAt: parsed.data.expiresAt ?? null,
      })
      // The raw token is returned exactly once and never stored — only its
      // SHA-256 lives in the DB, so no later read path can surface it.
      return c.json({ token: created.token, pat: created.meta }, 201)
    },
  )

  // RFC-247 D16 / T27 — the owner's own call log. Placed BEFORE `/:id` so the
  // literal segment is not swallowed by the parameter route.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/pats/audit',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Recent calls made with your own tokens',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await listTokenAuditForUser(deps.db, actor.user.id))
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/auth/pats/:id',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Revoke one of own personal access tokens',
    },
    async (c) => {
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
    },
  )

  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/auth/identities',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'List own linked OIDC identities',
    },
    async (c) => {
      const actor = actorOf(c)
      return c.json(await listIdentitiesForUser(deps.db, actor.user.id))
    },
  )

  registerRoute(
    app,
    {
      method: 'DELETE',
      path: '/api/auth/identities/:id',
      permissions: ['account:self'],
      tokenAccess: 'never',
      summary: 'Unlink an OIDC identity',
    },
    async () => {
      throw new ForbiddenError('identity-unlink-disabled', 'linked identities are read-only')
    },
  )
}
