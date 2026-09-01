// RFC-349 — auth/OIDC/identity callers receive Promise application bindings;
// process bootstrap owns provider selection and database lifetime.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'

import { buildActor } from '@/auth/actor'
import { authCommand } from '@/cli/auth'
import { createSqliteAuthRuntime } from '@/auth/composition'
import { createInMemoryDb } from '@/db/client'
import { mountOidcRoutes } from '@/routes/oidc'
import { resetRouteMetaRegistry } from '@/routes/registry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
}

describe('RFC-349 auth caller closure', () => {
  test('OIDC and CLI callers contain no provider handle or legacy auth store', () => {
    const oidcRoute = source('src/routes/oidc.ts')
    const authCli = source('src/cli/auth.ts')
    const userBootstrap = source('src/cli/userBootstrap.ts')
    const userOperations = source('src/modules/identity-access/composition/userOperations.ts')
    const usersService = source('src/services/users.ts')
    const sqliteUserFixture = source(
      'src/modules/identity-access/infrastructure/legacySqliteUserService.ts',
    )

    expect(oidcRoute).not.toContain("from '@/server'")
    expect(oidcRoute).not.toContain('deps.db')
    expect(oidcRoute).not.toContain("from '@/auth/loginPolicy'")
    expect(oidcRoute).not.toContain('createOidcProvidersService({')

    for (const caller of [authCli, userBootstrap, userOperations]) {
      expect(caller).not.toContain('DbClient')
      expect(caller).not.toContain("from '@/auth/loginPolicy'")
      expect(caller).not.toContain("from '@/auth/sessionStore'")
    }
    expect(userOperations).not.toContain("from '@/services/users'")
    expect(usersService).not.toContain('DbClient')
    expect(usersService).not.toContain("from '@/db/schema'")
    expect(usersService).not.toContain("from '@/auth/sessionStore'")
    expect(usersService).not.toContain("from '@/services/accountAuthPolicy'")
    expect(sqliteUserFixture).toContain('await auth.writeLocalPasswordIfUnmanaged')
    expect(sqliteUserFixture).toContain('await auth.revokeAllSessionsForUser')
  })

  test('auth recovery CLI consumes the same Promise runtime as the daemon', async () => {
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    const auth = createSqliteAuthRuntime({ db, revalidate: () => {} })
    await auth.completeBootstrap(
      {
        id: 'cli-admin',
        username: 'cli-admin',
        displayName: 'CLI Admin',
        passwordHash: 'verified-hash',
      },
      10,
    )

    await expect(authCommand(['password-login', 'status'], auth)).resolves.toEqual({
      output: 'password login: enabled\nbootstrap: complete (daemon token retired)\n',
      status: 'ok',
    })
    const enabled = await authCommand(['password-login', 'enable'], auth)
    expect(enabled).toMatchObject({ status: 'ok' })
    expect(enabled.output).toContain('daemon token remains retired')
  })

  test('OIDC policy route awaits its injected auth runtime without a database handle', async () => {
    resetRouteMetaRegistry()
    const db = createInMemoryDb(MIGRATIONS, { bootstrap: 'required' })
    const auth = createSqliteAuthRuntime({ db, revalidate: () => {} })
    await auth.completeBootstrap(
      {
        id: 'route-admin',
        username: 'route-admin',
        displayName: 'Route Admin',
        passwordHash: 'verified-hash',
      },
      10,
    )
    const actor = buildActor({
      source: 'daemon',
      user: {
        id: 'route-admin',
        username: 'route-admin',
        displayName: 'Route Admin',
        role: 'admin',
        status: 'active',
      },
    })
    const app = new Hono()
    const inject: MiddlewareHandler = async (context, next) => {
      context.set('actor', actor)
      await next()
    }
    app.use('*', inject)
    mountOidcRoutes(app, { auth, providers: null })

    const read = await app.request('/api/oidc/login-policy')
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ bootstrapCompletedAt: 10 })

    const update = await app.request('/api/oidc/login-policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ oidcDefaultRole: 'guest' }),
    })
    expect(update.status).toBe(200)
    expect(await update.json()).toMatchObject({ oidcDefaultRole: 'guest' })
  })
})
