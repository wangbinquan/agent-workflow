// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { Hono } from 'hono'
import type { WorkflowRevision } from '@agent-workflow/shared'
import { actorOf, tryActorOf } from '@/auth/actor'
import type { SecretBox } from '@/auth/secretBox'
import { multiAuth } from '@/auth/session'
import { recordTokenCall, takeDeleteSnapshot } from '@/services/tokenAudit'
import { assertRouteMetaCoverage, registerRoute } from '@/routes/registry'
import type { DbClient } from '@/db/client'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import type { SmokeOptions, SmokeResult } from '@/services/runtimeSmoke'
import { getEmbeddedFrontendResponse, IS_EMBEDDED } from '@/embed'
import { mountMcpTransport } from '@/mcp/server'
import { mountAgentRoutes } from '@/routes/agents'
import { mountAuthRoutes } from '@/routes/auth'
import { mountBackupRoutes } from '@/routes/backup'
import { mountRestoreRoutes } from '@/routes/restore'
import { mountCachedRepoRoutes } from '@/routes/cached-repos'
import { mountRepoGroupRoutes } from '@/routes/repoGroups'
import { mountConfigRoutes } from '@/routes/config'
import { mountDaemonRoutes } from '@/routes/daemon'
import { mountDocsRoutes, mountWellKnownRoutes } from '@/routes/docs'
import { mountHealthRoutes } from '@/routes/health'
import { mountWebhookIngressRoutes } from '@/routes/webhooks'
import type { WebhookDispatcher } from '@/services/webhook/dispatcherTypes'
import type { MrTerminalControl } from '@/modules/integration/public/mrTerminalControl'
import { composeIdentityAccess } from '@/modules/identity-access/composition'
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
import { mountIntentSessionRoutes } from '@/routes/intentSessions'
import type { SystemAgentRunOptions, SystemAgentRunResult } from '@/services/systemAgentRun'
import { mountReviewRoutes } from '@/routes/reviews'
import { mountTaskRoutes } from '@/routes/tasks'
import { mountScheduledTaskRoutes } from '@/routes/scheduledTasks'
import { mountCodeHostRoutes } from '@/routes/codeHosts'
import { mountCodeRoutes } from '@/routes/code'
import { mountWebhookEndpointRoutes } from '@/routes/webhookEndpoints'
import { mountWebhookTriggerRoutes } from '@/routes/webhookTriggers'
import { mountWebhookDeliveryRoutes } from '@/routes/webhookDeliveries'
import { mountWorkflowRoutes } from '@/routes/workflows'
import { mountWorkgroupRoutes } from '@/routes/workgroups'
import { registerResourcePackageRoutes } from '@/routes/resourcePackages'
import { Paths } from '@/util/paths'
import { mountWorkgroupTaskRoutes } from '@/routes/workgroupTasks'
import { mountWorktreeFilesRoutes } from '@/routes/worktree-files'
import { mountPortArtifactRoutes } from '@/routes/port-artifacts'
import { errorHandler } from '@/util/errors'
import { createLogger } from '@/util/log'

/**
 * Narrow in-process dependency seams for route tests that exercise diagnostics
 * with deterministic fixture executables. Production startup never supplies
 * these; there is no config, environment, or HTTP switch that can select them.
 */
export interface RuntimeDiagnosticTestDependencies {
  smokeRuntime(options: SmokeOptions): Promise<SmokeResult>
  /**
   * Deterministic finalization seam for the runtime-probe/config fence race.
   * Production never supplies it.
   */
  beforeRuntimeProbeCache?(): void | Promise<void>
  /**
   * RFC-284 T26 — per-row `--version` probe timeout for /api/runtimes/status.
   * Test-only injection（取代已删除的同名 env 通道，见 docs/env-flags.md
   * §已删除）；production keeps the 5s default.
   */
  probeTimeoutMsForTest?: number
}

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
  /**
   * Legacy-compatible health field. RFC-226 production startup never probes
   * optional OpenCode and therefore passes null; tests may inject a string to
   * verify compatibility with older health payloads.
   */
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
   * RFC-257 — async webhook dispatch (the T6 fan-out engine). The public
   * ingress route refuses to mount without BOTH this and secretBox (same
   * self-skip discipline as OIDC) so a partially-wired app never exposes a
   * guaranteed-500 public route.
   */
  webhookDispatcher?: WebhookDispatcher
  /** RFC-303 durable launch guard + terminal effect worker. */
  webhookTerminalControl?: MrTerminalControl
  /**
   * RFC-269 — outbound `fetch` seam for code-host calls (connection tests and
   * the call-node executor). Production omits it and the real `fetch` is used;
   * tests inject a stub so no suite ever depends on reaching gitlab.com.
   */
  codeHostFetch?: (url: string, init?: RequestInit) => Promise<Response>
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
  /**
   * Test-only route dependency injection. Production callers must omit this;
   * the default path always invokes the registered runtime naturally.
   */
  runtimeDiagnosticTestDependencies?: Partial<RuntimeDiagnosticTestDependencies>
  /** RFC-234 test seam: stub the intent turn's system-agent run. */
  intentTestDependencies?: {
    runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
  }
  /** RFC-238 test seams; production uses the real runtime runner and app home. */
  mcpRuntimeTestDependencies?: {
    runFn?: (opts: SystemAgentRunOptions) => Promise<SystemAgentRunResult>
    now?: () => number
    appHome?: string
    capacity?: number
  }
}

export function createApp(deps: AppDeps): Hono {
  const log = createLogger('http')
  const app = new Hono()
  const identityAccess = composeIdentityAccess(deps.db)

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    log.debug('req', { method: c.req.method, path: c.req.path, status: c.res.status, ms })
  })

  // Public routes (no auth).
  mountHealthRoutes(app, deps, identityAccess.diagnostics)
  // RFC-247 D18 — discovery must answer before any credential exists.
  mountWellKnownRoutes(app, deps)
  // RFC-257 — code-host webhook ingress. Public by design (caller is GitLab);
  // authenticated by per-endpoint secret + URL token inside the handler.
  mountWebhookIngressRoutes(app, deps)

  // Authenticated routes — three-track auth (RFC-036): session token / PAT /
  // legacy daemon token. Daemon token still maps to the seeded __system__
  // admin actor so existing single-user deployments stay zero-touch.
  app.use('/api/*', multiAuth({ db: deps.db, daemonToken: deps.token }))

  // RFC-247 D16 — the REST half of the token audit. Mounted right after
  // multiAuth so the actor exists, and BEFORE the routes so it observes every
  // one of them including the ones that throw. It records after `next()` and
  // never rethrows: an audit failure must not turn a working call into a 500
  // (F13). `/api/mcp` records per TOOL instead — a single "POST /api/mcp" row
  // would say nothing about what the model actually did.
  app.use('/api/*', async (c, next) => {
    await next()
    const actor = tryActorOf(c)
    if (actor === null || actor.source !== 'pat') return
    if (c.req.path === '/api/mcp') return
    void recordTokenCall(deps.db, {
      actor,
      channel: 'rest',
      method: c.req.method,
      path: c.req.path,
      statusCode: c.res.status,
      // AC-20 — captured by the delete route before it removed the row; the
      // row itself is unreachable from here.
      deletedSnapshot: takeDeleteSnapshot(c),
    })
  })

  // /api/whoami returns the resolved actor; keeps `ok`/`pid` fields for
  // backwards compatibility with anything that pinged the P-1-08 probe.
  registerRoute(
    app,
    {
      method: 'GET',
      path: '/api/whoami',
      permissions: [],
      publicReason:
        'identity self-introspection; any authenticated actor may ask who it is, and a token needs it because RFC-247 D6 closes /api/auth/me to tokens',
      tokenAccess: 'allow',
      summary: 'Resolved actor identity for the current credential',
    },
    (c) => {
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
    },
  )

  // RFC-247 T4 — the manual permission gates that used to live here are GONE.
  //
  // They were mounted by PATH PREFIX (`app.use('/api/skills/*', …)`) and by
  // hand-written method mapping, which is why whole domains shipped with no
  // gate at all: nothing forced a new route to acquire one, and nothing could
  // answer "which permission does this endpoint need" for an arbitrary path.
  //
  // Every route now declares its own contract via `registerRoute` and the
  // framework derives the gate from that declaration. The startup self-check
  // below refuses to boot when the declarations and the mounted routes
  // disagree in EITHER direction, which is what makes the guarantee real
  // rather than aspirational.

  mountApiRoutes(app, deps)

  // RFC-247 §4.1 — the MCP transport. Mounted after the REST table (it builds a
  // second, actor-injected copy of that table for tool dispatch) and inside the
  // /api/* auth scope, so the credential is resolved before it is inspected.
  mountMcpTransport(app, deps)

  // RFC-247 T4 — refuse to boot on a coverage mismatch, in either direction.
  // Placed after every mount and before the SPA fallback so it sees the real
  // route table. `app.routes` is Hono's own registry of what was mounted, so a
  // route cannot hide from this by being registered through some other helper.
  assertRouteMetaCoverage(app.routes.map((r) => ({ method: r.method, path: r.path })))

  app.onError(errorHandler)

  // P-5-05: When running as the compiled single-binary, the daemon also
  // serves the frontend SPA from its embedded asset table. /, /index.html,
  // and any /assets/* path map directly; unknown client-side routes fall back
  // to index.html so TanStack Router can handle a hard refresh. Missing
  // /assets/* paths stay 404 instead of returning HTML to a JS/CSS request.
  // In dev mode IS_EMBEDDED=false and these handlers are no-ops, letting the
  // vite dev server serve the SPA on its own port.
  if (IS_EMBEDDED) {
    app.get('*', async (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/ws/')) {
        return c.json(
          { ok: false, code: 'route-not-found', message: `no route for ${c.req.path}` },
          404,
        )
      }
      const response = await getEmbeddedFrontendResponse(c.req.path)
      if (response !== null) return response
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

/**
 * Every `/api/*` route, mounted onto whatever app is passed in.
 *
 * Split out of `createApp` for RFC-247's MCP transport: the MCP tools dispatch
 * into THIS SAME route table with an injected actor, rather than reaching past
 * it into the services. That is the whole reason MCP cannot become a second,
 * weaker authorization surface — every gate, payload validation and row-level
 * ACL check a REST caller passes through is the identical code path, not a
 * parallel implementation that has to be kept in agreement with it.
 *
 * Note what is deliberately NOT here: `multiAuth`. Authentication belongs to
 * the entry point (HTTP for `createApp`, the token that opened the MCP session
 * for the dispatcher), while authorization belongs to the route declarations.
 */
export function mountApiRoutes(app: Hono, deps: AppDeps): void {
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
  mountRepoGroupRoutes(app, deps)
  mountWorkflowRoutes(app, deps)
  mountWorkgroupRoutes(app, deps) // RFC-164
  // RFC-271 配置包：导出六条 + 导入两条。需要 secretBox 来签 previewToken——
  // 缺它时**整组不挂**（与 OIDC 路由同姿势），而不是退化成一个不签名的版本：
  // 不签名的 preview→commit 绑定等于没有绑定。
  if (deps.secretBox !== undefined) {
    registerResourcePackageRoutes(app, {
      db: deps.db,
      appHome: Paths.root,
      box: deps.secretBox,
    })
  }
  mountWorkgroupTaskRoutes(app, deps) // RFC-164 PR-4
  mountTaskRoutes(app, deps)
  mountScheduledTaskRoutes(app, deps) // RFC-159
  mountWebhookEndpointRoutes(app, deps) // RFC-257 T7
  mountCodeHostRoutes(app, deps) // RFC-269
  mountCodeRoutes(app, deps) // RFC-304 T31b
  mountWebhookTriggerRoutes(app, deps) // RFC-257 T8
  mountWebhookDeliveryRoutes(app, deps) // RFC-257 T9
  mountBackupRoutes(app, deps)
  mountRestoreRoutes(app, deps)
  mountWorktreeFilesRoutes(app, deps)
  mountPortArtifactRoutes(app, deps)
  mountReviewRoutes(app, deps)
  mountClarifyRoutes(app, deps)
  mountTaskQuestionRoutes(app, deps)
  mountTaskClarifyDirectiveRoutes(app, deps)
  mountFusionRoutes(app, deps)
  mountIntentSessionRoutes(app, deps) // RFC-234
  mountMemoryRoutes(app, deps)
  mountMemoryDistillJobRoutes(app, deps)
  mountTaskFeedbackRoutes(app, deps)
  // RFC-036 — auth + OIDC + user-CRUD routes. The first three are always
  // mounted; OIDC routes self-skip when deps.secretBox is omitted.
  mountAuthRoutes(app, deps)
  mountOidcAuthRoutes(app, deps)
  mountOidcRoutes(app, deps)
  mountUserRoutes(app, deps, composeIdentityAccess(deps.db))
  mountDocsRoutes(app, deps) // RFC-247 D17
}
