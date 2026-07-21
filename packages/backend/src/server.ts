// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import type { WorkflowRevision } from '@agent-workflow/shared'
import { actorOf } from '@/auth/actor'
import { requirePermission, resourcePermissionGate } from '@/auth/permissions'
import type { SecretBox } from '@/auth/secretBox'
import { multiAuth } from '@/auth/session'
import type { DbClient } from '@/db/client'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { ForbiddenError } from '@/util/errors'
import { getEmbeddedAsset, IS_EMBEDDED } from '@/embed'
import { mountAgentRoutes } from '@/routes/agents'
import { mountAuthRoutes } from '@/routes/auth'
import { mountBackupRoutes } from '@/routes/backup'
import { mountRestoreRoutes } from '@/routes/restore'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import { mountConfigRoutes } from '@/routes/config'
import { mountDaemonRoutes } from '@/routes/daemon'
import { mountHealthRoutes } from '@/routes/health'
import { mountMcpRoutes } from '@/routes/mcps'
import { mountMemoryRoutes } from '@/routes/memories'
import { mountMemoryDistillJobRoutes } from '@/routes/memoryDistillJobs'
import { mountTaskFeedbackRoutes } from '@/routes/taskFeedback'
import { mountOverviewRoutes } from '@/routes/overview'
import { mountOidcRoutes } from '@/routes/oidc'
import { mountOidcAuthRoutes } from '@/routes/oidc-auth'
import { mountPlantumlRoutes } from '@/routes/plantuml'
import { mountPluginRoutes } from '@/routes/plugins'
import { mountUserRoutes } from '@/routes/users'
import { mountRepoRoutes } from '@/routes/repos'
import { mountRuntimeRoutes } from '@/routes/runtime'
import { mountRuntimesRoutes } from '@/routes/runtimes'
import { mountSkillRoutes } from '@/routes/skills'
import { mountClarifyRoutes } from '@/routes/clarify'
import { mountTaskQuestionRoutes } from '@/routes/taskQuestions'
import { mountTaskClarifyDirectiveRoutes } from '@/routes/taskClarifyDirective'
import { mountFusionRoutes } from '@/routes/fusions'
import { mountReviewRoutes } from '@/routes/reviews'
import { mountTaskRoutes } from '@/routes/tasks'
import { mountScheduledTaskRoutes } from '@/routes/scheduledTasks'
import { mountWorkflowRoutes } from '@/routes/workflows'
import { mountWorkgroupRoutes } from '@/routes/workgroups'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountWorktreeFilesRoutes } from '@/routes/worktree-files'
import { mountPortArtifactRoutes } from '@/routes/port-artifacts'
import { errorHandler } from '@/util/errors'
import { createLogger } from '@/util/log'

export interface AppDeps {
  /** Token required for /api/*. */
  token: string
  /** Absolute path to config.json (lets tests use a temp file). */
  configPath: string
  /**
   * Absolute path to the daemon run-info file (host/port/url the daemon is
   * actually bound to). Optional — defaults to `Paths.daemonInfo` in the route;
   * tests inject a temp file. Read by GET /api/daemon.
   */
  daemonInfoPath?: string
  /** Opencode version detected at startup; null if probe failed. */
  opencodeVersion: string | null
  /** DB schema version (count of applied migrations). */
  dbVersion: number
  /** Drizzle DB client. */
  db: DbClient
  /**
   * RFC-036 — AES-256-GCM seal/unseal helper. Required only for the OIDC
   * routes (admin CRUD + login callback). Tests that do not exercise OIDC
   * can omit it; the OIDC routes refuse to mount without it.
   */
  secretBox?: SecretBox
  /**
   * RFC-159 — override the scheduled-task run-now launch closure. Production
   * omits it (the route builds the real one from db + configPath); tests inject
   * a stub so POST /:id/run-now doesn't spawn a real opencode task.
   */
  buildScheduleLaunch?: BuildScheduleLaunch
  /**
   * RFC-199 deterministic concurrency seam for exact workflow consumers.
   * Production leaves this undefined. Tests use it to commit a concurrent
   * workflow writer after the exact-revision guard and prove validation/YAML
   * serialization still consume the one captured immutable revision.
   */
  workflowExactOperationHook?: (input: {
    operation: 'validate' | 'export'
    revision: WorkflowRevision
  }) => void | Promise<void>
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

  // Authenticated routes — three-track auth (RFC-036): session token / PAT /
  // legacy daemon token. Daemon token still maps to the seeded __system__
  // admin actor so existing single-user deployments stay zero-touch.
  app.use('/api/*', multiAuth({ db: deps.db, daemonToken: deps.token }))

  // /api/whoami returns the resolved actor; keeps `ok`/`pid` fields for
  // backwards compatibility with anything that pinged the P-1-08 probe.
  app.get('/api/whoami', (c) => {
    const actor = actorOf(c)
    return c.json({
      ok: true,
      pid: process.pid,
      uptime: Math.round(process.uptime()),
      user: {
        id: actor.user.id,
        username: actor.user.username,
        displayName: actor.user.displayName,
        role: actor.user.role,
        status: actor.user.status,
      },
      source: actor.source,
    })
  })

  // RFC-036 permission gates. Mounted BEFORE the route handlers so a non-
  // permitted actor (e.g. a regular-user session token) is rejected with 403
  // before any service-layer code runs. The gates pick the permission point
  // from the request method (GET → :read, mutating verbs → :write).
  // RFC-165 (F15/N1): launching is a TASK operation on every subject face —
  // all three launch endpoints gate on tasks:launch uniformly, and the agent
  // launch path is exempt from the agents:write method gate below.
  app.on('POST', '/api/tasks', requirePermission('tasks:launch'))
  app.on('POST', '/api/workgroups/:name/tasks', requirePermission('tasks:launch'))
  app.on('POST', '/api/agents/:name/tasks', requirePermission('tasks:launch'))
  app.use(
    '/api/agents',
    resourcePermissionGate('agents', {
      skip: (method, path) => method === 'POST' && /^\/api\/agents\/[^/]+\/tasks$/.test(path),
    }),
  )
  app.use(
    '/api/agents/*',
    resourcePermissionGate('agents', {
      skip: (method, path) => method === 'POST' && /^\/api\/agents\/[^/]+\/tasks$/.test(path),
    }),
  )
  app.use('/api/skills', resourcePermissionGate('skills'))
  app.use('/api/skills/*', resourcePermissionGate('skills'))
  app.use('/api/mcps', resourcePermissionGate('mcps'))
  app.use('/api/mcps/*', resourcePermissionGate('mcps'))
  app.use('/api/plugins', resourcePermissionGate('plugins'))
  app.use('/api/plugins/*', resourcePermissionGate('plugins'))
  app.use('/api/workflows', resourcePermissionGate('workflows'))
  app.use('/api/workflows/*', resourcePermissionGate('workflows'))
  app.use('/api/repos', resourcePermissionGate('repos'))
  app.use('/api/repos/*', resourcePermissionGate('repos'))
  app.use('/api/cached-repos', resourcePermissionGate('repos'))
  app.use('/api/cached-repos/*', resourcePermissionGate('repos'))

  // Admin-only end points: settings, OIDC providers, backup. /api/users +
  // /api/users/search are mounted in mountUserRoutes (PR3/PR5) and have
  // their own bespoke gates (search is admin+user, the rest admin-only).
  const configGate: MiddlewareHandler = async (c, next) => {
    const perm =
      c.req.method === 'GET' || c.req.method === 'HEAD' ? 'settings:read' : 'settings:write'
    const actor = actorOf(c)
    if (!actor.permissions.has(perm)) {
      throw new ForbiddenError('forbidden', `missing permission: ${perm}`, {
        requiredPermission: perm,
        actorPermissions: [...actor.permissions],
      })
    }
    await next()
  }
  app.use('/api/config', configGate)
  app.use('/api/config/*', configGate)
  // GET /api/daemon surfaces the same Network-settings readout as /api/config
  // (daemon bind host/port + pid/startedAt). Gate it with settings:read like
  // config so a regular user session / narrow PAT can't read daemon internals
  // through the generic /api/* auth. Read-only route → no write variant.
  app.use('/api/daemon', requirePermission('settings:read'))
  app.use('/api/backup', requirePermission('backup:run'))
  app.use('/api/backup/*', requirePermission('backup:run'))
  app.use('/api/restore', requirePermission('backup:run'))

  // runtime is admin+user — homepage runtime dot relies on it.
  app.use('/api/runtime', requirePermission('runtime:read'))
  app.use('/api/runtime/*', requirePermission('runtime:read'))

  mountConfigRoutes(app, deps)
  mountDaemonRoutes(app, deps)
  mountPlantumlRoutes(app, deps)
  mountRuntimeRoutes(app, deps)
  mountRuntimesRoutes(app, deps)
  mountOverviewRoutes(app, deps) // RFC-190
  mountAgentRoutes(app, deps)
  mountMcpRoutes(app, deps)
  mountPluginRoutes(app, deps)
  mountSkillRoutes(app, deps)
  mountRepoRoutes(app, deps)
  mountCachedRepoRoutes(app, deps)
  mountWorkflowRoutes(app, deps)
  mountWorkgroupRoutes(app, deps) // RFC-164
  mountWorkgroupTaskRoutes(app, deps) // RFC-164 PR-4
  mountTaskRoutes(app, deps)
  mountScheduledTaskRoutes(app, deps) // RFC-159
  mountBackupRoutes(app, deps)
  mountRestoreRoutes(app, deps)
  mountWorktreeFilesRoutes(app, deps)
  mountPortArtifactRoutes(app, deps)
  mountReviewRoutes(app, deps)
  mountClarifyRoutes(app, deps)
  mountTaskQuestionRoutes(app, deps)
  mountTaskClarifyDirectiveRoutes(app, deps)
  mountFusionRoutes(app, deps)
  mountMemoryRoutes(app, deps)
  mountMemoryDistillJobRoutes(app, deps)
  mountTaskFeedbackRoutes(app, deps)
  // RFC-036 — auth + OIDC + user-CRUD routes. The first three are always
  // mounted; OIDC routes self-skip when deps.secretBox is omitted.
  mountAuthRoutes(app, deps)
  mountOidcAuthRoutes(app, deps)
  mountOidcRoutes(app, deps)
  mountUserRoutes(app, deps)

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
