// RFC-390: both production-shaped HTTP lanes expose database telemetry; the former SQLite wiring did not.
import { expect, test } from 'bun:test'
import { Hono, type MiddlewareHandler } from 'hono'
import { join } from 'node:path'
import { buildActor } from '@/auth/actor'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'
import { mountMaintenanceRoutes } from '@/routes/maintenance'
import { createUser } from '@/services/users'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'
import { createRouteOperationDispatcher } from './helpers/routeOperationDispatcher'

const TOKEN = 'd'.repeat(64)
describeEachProviderHttpApplication(
  'RFC-390 maintenance database telemetry',
  {
    token: TOKEN,
    dbVersion: 1,
    opencodeVersion: null,
    tempPrefix: 'aw-rfc390-maintenance-',
  },
  (scope) => {
    test('REST and its MCP operation both carry the selected database telemetry', async () => {
      const opened = await scope.open()
      const response = await opened.app.request('/api/maintenance/status', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      expect(response.status).toBe(200)
      const status = (await response.json()) as {
        database: { version: number; provider: string; poolWait: unknown }
      }
      expect(status.database).toMatchObject({
        version: 1,
        provider: scope.harness.applicationBinding.provider,
      })
      if (scope.harness.applicationBinding.provider === 'sqlite')
        expect(status.database.poolWait).toBeNull()
      const user = await createUser(scope.harness.db, {
        username: 'maintenance-reader',
        displayName: 'Maintenance',
        role: 'admin',
        password: 'longEnoughPassword',
      })
      const dispatch = createRouteOperationDispatcher(opened)
      const result = await dispatch(
        { method: 'GET', path: '/api/maintenance/status' },
        buildActor({
          user,
          source: 'session',
        }),
      )
      expect(result.status).toBe(200)
      expect(result.body).toMatchObject({
        database: { version: 1, provider: scope.harness.applicationBinding.provider },
      })
    })
    test('former wiring control omits database only when no telemetry is supplied', async () => {
      const opened = await scope.open()
      const configuration = composeApplicationConfigurationBinding({
        kind: 'file',
        configPath: join(opened.appHome, 'config.json'),
      }).queries
      // Reproduce the old SQLite route input, retaining the real status/config route implementation.
      const former = new Hono()
      const injectActor: MiddlewareHandler = async (context, next) => {
        context.set(
          'actor',
          buildActor({
            user: {
              id: 'former-maintenance-admin',
              username: 'former-admin',
              displayName: 'Former Admin',
              role: 'admin',
              status: 'active',
            },
            source: 'session',
          }),
        )
        await next()
      }
      former.use('*', injectActor)
      mountMaintenanceRoutes(former, { configuration })
      const before = await former.request('/api/maintenance/status')
      expect(before.status).toBe(200)
      const previous = (await before.json()) as Record<string, unknown>
      expect(previous).not.toHaveProperty('database')
      const current = await opened.app.request('/api/maintenance/status', {
        headers: { authorization: `Bearer ${TOKEN}` },
      })
      const after = (await current.json()) as Record<string, unknown>
      expect(after).toMatchObject(previous)
      expect(after).toHaveProperty('database')
    })
  },
)
