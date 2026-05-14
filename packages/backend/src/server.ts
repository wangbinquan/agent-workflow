// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { Hono } from 'hono'
import { tokenAuth } from '@/auth/token'
import type { DbClient } from '@/db/client'
import { mountAgentRoutes } from '@/routes/agents'
import { mountConfigRoutes } from '@/routes/config'
import { mountHealthRoutes } from '@/routes/health'
import { mountSkillRoutes } from '@/routes/skills'
import { errorHandler } from '@/util/errors'
import { createLogger } from '@/util/log'

export interface AppDeps {
  /** Token required for /api/*. */
  token: string
  /** Absolute path to config.json (lets tests use a temp file). */
  configPath: string
  /** Opencode version detected at startup; null if probe failed. */
  opencodeVersion: string | null
  /** DB schema version (count of applied migrations). */
  dbVersion: number
  /** Drizzle DB client. */
  db: DbClient
}

export function createApp(deps: AppDeps): Hono {
  const log = createLogger('http')
  const app = new Hono()

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    log.debug('req', { method: c.req.method, path: c.req.path, status: c.res.status, ms })
  })

  // Public routes (no auth).
  mountHealthRoutes(app, deps)

  // Authenticated routes — token middleware before any /api/* declaration.
  app.use('/api/*', tokenAuth(deps.token))

  // Tiny probe endpoint to verify the auth path; superseded by real routes in P-1-08+.
  app.get('/api/whoami', (c) =>
    c.json({ ok: true, pid: process.pid, uptime: Math.round(process.uptime()) }),
  )

  mountConfigRoutes(app, deps)
  mountAgentRoutes(app, deps)
  mountSkillRoutes(app, deps)

  app.onError(errorHandler)
  app.notFound((c) =>
    c.json({ ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` }, 404),
  )

  return app
}
