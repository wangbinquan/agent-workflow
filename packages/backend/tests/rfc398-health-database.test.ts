// RFC-398 §2.7: health must identify the selected PG connection, not the source URL.
import { expect, test } from 'bun:test'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { mountHealthRoutes } from '@/routes/health'
import { describeEachProviderHttpApplication } from './helpers/providerHttpApplicationScope'

describeEachProviderHttpApplication(
  'RFC-398 actual health database',
  {
    token: 'a'.repeat(64),
    dbVersion: 1,
    tempPrefix: 'aw-health-identity-',
  },
  (scope) => {
    test('both health URLs report the active connection identity without connection settings', async () => {
      const { app } = await scope.open()
      const provider = scope.harness.applicationBinding.provider
      const databaseName =
        provider === 'postgresql'
          ? (
              await scope.harness.db
                .select({ name: sql<string>`current_database()` })
                .from(sql`(SELECT 1) AS expected_identity`)
            )[0]!.name
          : null
      for (const path of ['/health']) {
        const response = await app.request(path)
        expect(response.status).toBe(200)
        const body = (await response.json()) as {
          ok: boolean
          database: { provider: string; databaseName: string | null }
        }
        expect(body.ok).toBe(true)
        expect(body.database).toEqual({ provider, databaseName })
        if (provider === 'postgresql') expect(databaseName).toBeTruthy()
      }
    })
  },
)

test('health liveness survives an unavailable identity query without publishing the query error', async () => {
  const app = new Hono()
  mountHealthRoutes(
    app,
    {
      opencodeVersion: null,
      dbVersion: 1,
      databaseIdentity: async () => {
        throw new Error('postgresql://user:password@example/source')
      },
    },
    {
      snapshot: () => ({
        accessUpdate: { success: 0, noOp: 0, conflict: 0, rejected: 0 },
        authorityReresolution: 0,
        invalidStoredGrant: 0,
        wsTargetedRefreshFailure: 0,
      }),
    },
    { countRunningTasks: async () => 0 },
  )
  const response = await app.request('/health')
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body).toMatchObject({ ok: true, database: null })
  expect(JSON.stringify(body)).not.toContain('password')
})
