// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { Hono } from 'hono'
import { tokenAuth } from '@/auth/token'
import type { DbClient } from '@/db/client'
import { getEmbeddedAsset, IS_EMBEDDED } from '@/embed'
import { mountAgentRoutes } from '@/routes/agents'
import { mountBackupRoutes } from '@/routes/backup'
import { mountConfigRoutes } from '@/routes/config'
import { mountHealthRoutes } from '@/routes/health'
import { mountRepoRoutes } from '@/routes/repos'
import { mountRuntimeRoutes } from '@/routes/runtime'
import { mountSkillRoutes } from '@/routes/skills'
import { mountTaskRoutes } from '@/routes/tasks'
import { mountWorkflowRoutes } from '@/routes/workflows'
import { mountWorktreeFilesRoutes } from '@/routes/worktree-files'
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
  mountRuntimeRoutes(app, deps)
  mountAgentRoutes(app, deps)
  mountSkillRoutes(app, deps)
  mountRepoRoutes(app, deps)
  mountWorkflowRoutes(app, deps)
  mountTaskRoutes(app, deps)
  mountBackupRoutes(app, deps)
  mountWorktreeFilesRoutes(app, deps)

  app.onError(errorHandler)

  // P-5-05: When running as the compiled single-binary, the daemon also
  // serves the frontend SPA from its embedded asset table. /, /index.html,
  // and any /assets/* path map directly; unknown non-/api paths fall back
  // to index.html so TanStack Router can handle client-side routes after
  // a hard refresh. In dev mode IS_EMBEDDED=false and these handlers are
  // no-ops, letting the vite dev server serve the SPA on its own port.
  if (IS_EMBEDDED) {
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
        return c.json(
          { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
          404,
        )
      }
      const direct = await getEmbeddedAsset(stripLeadingSlash(c.req.path))
      if (direct !== null) {
        return new Response(direct.body, { headers: { 'content-type': direct.contentType } })
      }
      // SPA fallback.
      const indexHtml = await getEmbeddedAsset('index.html')
      if (indexHtml !== null) {
        return new Response(indexHtml.body, {
          headers: { 'content-type': indexHtml.contentType },
        })
      }
      return c.json(
        { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
        404,
      )
    })
  }

  app.notFound((c) =>
    c.json({ ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` }, 404),
  )

  return app
}

function stripLeadingSlash(p: string): string {
  return p.startsWith('/') ? p.slice(1) : p
}
