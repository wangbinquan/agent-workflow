// RFC-221 — linked identity means provider-managed at the account level.
// Self-service unlink and both self/admin password mutation paths must be
// denied server-side even when a mixed account still has a historical hash.

import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createSession } from './helpers/auth/sessionStore'

import { userIdentities, users } from '../src/db/schema'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createOidcProvidersService } from '../src/services/oidcProviders'
import { createIdentity } from '../src/services/userIdentities'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'c'.repeat(64)

// RFC-359 AC-6：两个引擎各跑一遍。
describeEachProviderHttpApplication(
  'RFC-221 OIDC-managed account policy',
  {
    token: DAEMON_TOKEN,
    opencodeVersion: 'test',
    dbVersion: 110,
    tempPrefix: 'aw-account-auth-',
  },
  (scope) => {
    test('change/reset/unlink deny and admin view marks the account', async () => {
      const db = scope.harness.db
      const secretBox = createSecretBoxFromKey(randomBytes(32))
      const provider = await createOidcProvidersService({ db, secretBox }).create({
        slug: 'corp',
        displayName: 'Corporate SSO',
        issuerUrl: 'https://idp.example.test',
        clientId: 'client',
        clientSecret: 'secret',
        scopes: 'openid profile email',
        provisioning: 'invite',
        allowedEmailDomains: [],
        iconUrl: null,
        enabled: true,
      })
      const user = await createUser(db, {
        username: 'mixed-user',
        displayName: 'Mixed User',
        role: 'user',
        password: 'oldPassword123',
      })
      const identity = await createIdentity(db, {
        userId: user.id,
        providerId: provider.id,
        subject: 'subject-1',
        email: 'mixed@example.test',
        emailVerified: true,
      })
      const { token } = await createSession({ db, userId: user.id })
      const app = (await scope.open()).app
      const as = (tokenValue: string, path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers)
        headers.set('Authorization', `Bearer ${tokenValue}`)
        if (init.body !== undefined) headers.set('content-type', 'application/json')
        return app.request(path, { ...init, headers })
      }

      const change = await as(token, '/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ oldPassword: 'oldPassword123', newPassword: 'newPassword123' }),
      })
      expect(change.status).toBe(403)
      expect(((await change.json()) as { code: string }).code).toBe('oidc-password-managed')

      const reset = await as(DAEMON_TOKEN, `/api/users/${user.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ newPassword: 'adminReset123' }),
      })
      expect(reset.status).toBe(403)
      expect(((await reset.json()) as { code: string }).code).toBe('oidc-password-managed')

      for (const id of [identity.id, 'unknown-identity']) {
        const unlink = await as(token, `/api/auth/identities/${id}`, { method: 'DELETE' })
        expect(unlink.status).toBe(403)
        expect(((await unlink.json()) as { code: string }).code).toBe('identity-unlink-disabled')
      }
      expect(await db.select().from(userIdentities)).toHaveLength(1)

      const list = await as(DAEMON_TOKEN, '/api/users')
      const rows = (await list.json()) as Array<{ id: string; hasOidcIdentity: boolean }>
      expect(rows.find((row) => row.id === user.id)?.hasOidcIdentity).toBe(true)
      const [userRow] = await db.select().from(users).where(eq(users.id, user.id))
      expect(userRow?.passwordHash).toBe(user.passwordHash)
    })
  },
)
