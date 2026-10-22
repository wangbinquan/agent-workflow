// RFC-395 II-pre：用户夹具改接生产 identity-access 运行时，保留原用例意图。
// RFC-349 — auth/OIDC/identity callers receive Promise application bindings;
// process bootstrap owns provider selection and database lifetime.

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Hono, type MiddlewareHandler } from 'hono'

import { buildActor } from '@/auth/actor'
import { authCommand } from '@/cli/auth'
import { createAuthRuntimeFor } from '@/auth/composition'
import { describeEachProvider } from './helpers/eachProvider'
import { mountOidcRoutes } from '@/routes/oidc'
import { resetRouteMetaRegistry } from '@/routes/registry'

function source(relativePath: string): string {
  return readFileSync(resolve(import.meta.dir, '..', relativePath), 'utf8')
}
// 第一条只读源码文本，与引擎无关，留普通 describe。
describe('RFC-349 auth caller closure（源码闭包）', () => {
  test('OIDC and CLI callers contain no provider handle or legacy auth store', () => {
    const oidcRoute = source('src/routes/oidc.ts')
    const authCli = source('src/cli/auth.ts')
    const userBootstrap = source('src/cli/userBootstrap.ts')
    const userOperations = source('src/modules/identity-access/composition/userOperations.ts')

    expect(oidcRoute).not.toContain("from '@/server'")
    expect(oidcRoute).not.toContain('deps.db')
    expect(oidcRoute).not.toContain("from '@/auth/loginPolicy'")
    expect(oidcRoute).not.toContain('createOidcProvidersService({')

    for (const caller of [authCli, userBootstrap, userOperations]) {
      expect(caller).not.toContain('DbClient')
      expect(caller).not.toContain("from '@/auth/loginPolicy'")
      expect(caller).not.toContain("from '@/auth/sessionStore'")
    }
    for (const path of [
      'src/services/users.ts',
      'src/modules/identity-access/composition/legacyUserService.ts',
      'src/modules/identity-access/infrastructure/legacyUserService.ts',
    ])
      expect(existsSync(resolve(import.meta.dir, '..', path))).toBe(false)
    expect(userOperations).toContain('await input.auth.writeLocalPasswordIfUnmanaged')
    expect(userOperations).toContain('await input.auth.revokeAllSessionsForUser')
  })
})

// RFC-359 AC-6：后两条真的建库，两个引擎各跑一遍。`bootstrap: 'required'` 保留「首个管理员
// 尚未创建」的初态——它正是这两条用例要走的 `completeBootstrap` 前提。
describeEachProvider(
  'RFC-349 auth caller closure（Promise 运行时）',
  (harness) => {
    test('auth recovery CLI consumes the same Promise runtime as the daemon', async () => {
      const db = harness.db
      const auth = createAuthRuntimeFor({ db, onCredentialRevoked: () => {} })
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
      const db = harness.db
      const auth = createAuthRuntimeFor({ db, onCredentialRevoked: () => {} })
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
  },
  { bootstrap: 'required' },
)
