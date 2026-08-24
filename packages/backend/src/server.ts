// Hono app factory. Routes that touch DB / config / version probe receive
// their dependencies via the `AppDeps` interface so tests can inject mocks
// without monkey-patching the module.

import { createEmployeeReactionRoundQueries } from '@/modules/digital-employee/composition'
import { Hono } from 'hono'
import type { WorkflowRevision } from '@agent-workflow/shared'
import { dirname, join } from 'node:path'
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
import {
  supportsEventCenterCodeHostDelivery,
  supportsEventCenterWorkStart,
  type WebhookDispatcher,
} from '@/services/webhook/dispatcherTypes'
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
import { mountMaintenanceDiskRoutes } from '@/routes/maintenanceDisk'
import { mountTaskArchiveRoutes } from '@/routes/taskArchive'
import { mountTaskRoutes } from '@/routes/tasks'
import { mountTaskCatalogRoutes } from '@/routes/taskCatalog'
import { mountScheduledTaskRoutes } from '@/routes/scheduledTasks'
import { mountCodeHostRoutes } from '@/routes/codeHosts'
import { mountAccountRepositoryTransportCredentialRoutes } from '@/routes/accountRepositoryTransportCredentials'
import { mountCapabilityTemplateRoutes } from '@/routes/capabilityTemplates'
import { mountDevelopmentConfigRoutes } from '@/routes/developmentConfig'
import { mountDevelopmentMissionRoutes } from '@/routes/developmentMissions'
import { mountDigitalEmployeeRoutes } from '@/routes/digitalEmployees'
import { mountEventCenterRoutes } from '@/routes/eventCenter'
import { mountExecutionContractRoutes } from '@/routes/executionContracts'
import { mountMissionInputUploadRoutes } from '@/routes/missionInputUploads'
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
import { loadConfig } from '@/config'
import { createLogger } from '@/util/log'
import {
  composeDigitalEmployee,
  composeDigitalEmployeeTaskCatalogSource,
  createEmployeeInputArtifactStore,
  createReactionExecutionAdapter,
  readPersistedDigitalEmployeeTypePackageDescriptorJsons,
  readDigitalEmployeeWriterState,
} from '@/modules/digital-employee/composition'
import {
  developmentExecutionContractRegistrations,
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  developmentImplicitAgentContractDeclarations,
} from '@/modules/development-automation/composition/employeeTypePackage'
import { composeExecutionContract } from '@/modules/execution-contract/composition'
import { composeEventCenter, type EventCenterModule } from '@/modules/event-center/composition'
import { composeDigitalEmployeeExecution } from '@/modules/task-execution/composition/digitalEmployeeExecution'
import { composeTaskExecutionCatalogSources } from '@/modules/task-execution/application/adapters/task-catalog-adapter'
import { composeDigitalEmployeeBuiltinToolCatalog } from '@/modules/task-execution/composition/digitalEmployeeBuiltinToolCatalog'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { SYSTEM_USER_ID } from '@/auth/systemIdentity'
import { composeDevelopmentEmployeeWorkspace } from '@/modules/development-automation/composition/digitalEmployeeWorkspace'
import { composeDevelopmentEmployeePlatformWorkItems } from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import { createDevelopmentMissionCodeHostEventContinuation } from '@/modules/development-automation/composition'
import {
  buildDevelopmentDeliveryDeps,
  resolveDevelopmentRepoBinding,
} from '@/services/developmentDeliveryDeps'
import {
  composeDevelopmentApprovalEventObserver,
  composeDevelopmentCodeHostEventObserver,
  composeDevelopmentEmployeeEventObserver,
} from '@/modules/integration/composition/digitalEmployeeEventObserver'
import { composeApprovalGatewayRunner } from '@/modules/integration/composition/approvalGateway'
import { composeDevelopmentToolConnectionCatalog } from '@/modules/integration/composition/digitalEmployeeToolConnections'
import {
  createCodeHostWebhookDeliveryConsumer,
  createCodeHostWebhookRoutingDirectory,
  createRepositoryEndpointDiscovery,
} from '@/modules/integration/composition'
import { codeHostEventCatalogJson } from '@/modules/integration/public/events'
import { taskLifecycleEventCatalogJson } from '@/modules/task-execution/public/events'
import { digitalEmployeeLifecycleEventCatalogJson } from '@/modules/digital-employee/public/events'
import type { DeferredDigitalEmployeeWorkStart } from '@/modules/integration/composition'
import {
  bindCandidateDeliveryParticipant,
  bindChangeCandidateParticipant,
  bindConflictMergeParticipant,
  bindEmployeeCaseWorkspaceParticipant,
  buildRepositoryTransportConnectionProjection,
  composeRepositoryTransportCredentials,
  createRepositoryPublicationTransport,
  reconcileRepositoryTransportConnectionProjections,
  type RepositoryTransportCredentialModule,
} from '@/modules/source-control/composition'
import { composeTaskCatalog } from '@/modules/task-catalog/composition'
import { createCodeHostConnectionsService } from '@/services/codeHost/connections'

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
  /**
   * RFC-317 T54 —— RFC-321 传输凭据模块，**由 bootstrap 装配**后传进来。
   *
   * 为什么不在 `mountApiRoutes` 里 compose：那个函数每进程被调用两次（REST 的
   * `createApp` 一次，MCP dispatcher 的私有 Hono app 在首次 MCP 请求时懒建一次），
   * 装配写在那里就是写在一个会跑两遍的地方。`composeRepositoryTransportCredentials`
   * 自己按 `(db, secretBox)` memoized，所以搬家前后行为逐字等价——搬的是位置，
   * 让代码落到它自己注释说的那个位置（"Bootstrap-owned"），也让 T54 的
   * 「路由函数里的装配只减不增」棘轮重新成立。
   *
   * `undefined`（直接调 `mountApiRoutes` 的调用方）与 `null`（没有 secretBox）
   * 都表示「没有传输凭据模块」。
   */
  repositoryTransport?: RepositoryTransportCredentialModule | null
  /** Token required for /api/*. */
  token: string
  /** Absolute path to config.json (lets tests use a temp file). */
  configPath: string
  /**
   * Root used for immutable digital-employee program artifacts and isolated
   * contract fixtures. Production derives it from configPath; tests may pin a
   * dedicated directory without touching the process-global Paths singleton.
   */
  appHome?: string
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
   * RFC-310 OS: production shares this durable Event Center composition with
   * webhook ingress so passive code-host hints can wake the subscribed poller.
   * Route tests may omit it and use the local DB-backed composition below.
   */
  digitalEmployeeEventCenter?: EventCenterModule
  /** Bun-dev only: serve the current type-package draft without rewriting its frozen DB row. */
  digitalEmployeeTypePackageDriftPolicy?: 'reject' | 'draft-overlay'
  /** Bootstrap-local late binding that makes orchestration and Employee Case peer work targets. */
  digitalEmployeeWorkStart?: DeferredDigitalEmployeeWorkStart
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

function composeApplicationEventCenter(deps: AppDeps): EventCenterModule {
  const approvalGateway = composeApprovalGatewayRunner(deps.db)
  const missionContinuation = createDevelopmentMissionCodeHostEventContinuation(deps.db)
  const codeHostDeliveryDispatcher =
    deps.webhookDispatcher !== undefined &&
    supportsEventCenterCodeHostDelivery(deps.webhookDispatcher)
      ? deps.webhookDispatcher
      : null
  const eventWorkStarter =
    deps.webhookDispatcher !== undefined && supportsEventCenterWorkStart(deps.webhookDispatcher)
      ? deps.webhookDispatcher
      : null
  return composeEventCenter({
    db: deps.db,
    typePackageDescriptorJsons: [
      developmentEmployeeTypePackage.descriptorJson,
      codeHostEventCatalogJson,
      taskLifecycleEventCatalogJson,
      digitalEmployeeLifecycleEventCatalogJson,
    ],
    observer: composeDevelopmentEmployeeEventObserver({
      codeHost: composeDevelopmentCodeHostEventObserver({
        binding: (repositoryId) =>
          resolveDevelopmentRepoBinding(deps.db, deps.secretBox, repositoryId),
      }),
      approval: composeDevelopmentApprovalEventObserver({ gateway: approvalGateway }),
    }),
    routingSubscriptions: createCodeHostWebhookRoutingDirectory(deps.db, missionContinuation),
    ...(eventWorkStarter === null
      ? {}
      : {
          automationWorkStart: {
            launch: (input) => eventWorkStarter.dispatchEventTarget(input),
          },
        }),
    deliveryConsumers:
      codeHostDeliveryDispatcher === null
        ? []
        : [
            createCodeHostWebhookDeliveryConsumer(
              deps.db,
              codeHostDeliveryDispatcher,
              missionContinuation,
            ),
          ],
    deliveryRetryLimits: {
      current() {
        const config = loadConfig(deps.configPath)
        return {
          defaultNodeRetries: config.defaultNodeRetries,
          sessionRestartBudget: config.sessionRestartBudget,
        }
      },
    },
  })
}

export function createApp(deps: AppDeps): Hono {
  const log = createLogger('http')
  const app = new Hono()
  const identityAccess = composeIdentityAccess(deps.db)
  const effectiveDeps: AppDeps = {
    ...(deps.digitalEmployeeEventCenter === undefined
      ? { ...deps, digitalEmployeeEventCenter: composeApplicationEventCenter(deps) }
      : deps),
    // RFC-317 T54：装配落在 bootstrap。`mountApiRoutes` 与 `mountMcpTransport`
    // 拿到的是**同一个**实例，dispatcher 那次懒建不再各建一套。
    repositoryTransport:
      deps.repositoryTransport ??
      (deps.secretBox === undefined
        ? null
        : composeRepositoryTransportCredentials(deps.db, deps.secretBox)),
  }

  app.use('*', async (c, next) => {
    const started = performance.now()
    await next()
    const ms = Math.round(performance.now() - started)
    log.debug('req', { method: c.req.method, path: c.req.path, status: c.res.status, ms })
  })

  // Public routes (no auth).
  mountHealthRoutes(app, effectiveDeps, identityAccess.diagnostics)
  // RFC-247 D18 — discovery must answer before any credential exists.
  mountWellKnownRoutes(app, effectiveDeps)
  // RFC-257 — code-host webhook ingress. Public by design (caller is GitLab);
  // authenticated by per-endpoint secret + URL token inside the handler.
  mountWebhookIngressRoutes(app, effectiveDeps)

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

  mountApiRoutes(app, effectiveDeps)

  // RFC-247 §4.1 — the MCP transport. Mounted after the REST table (it builds a
  // second, actor-injected copy of that table for tool dispatch) and inside the
  // /api/* auth scope, so the credential is resolved before it is inspected.
  mountMcpTransport(app, effectiveDeps)

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
  const identityAccess = composeIdentityAccess(deps.db)
  const appHome = deps.appHome ?? dirname(deps.configPath)
  const inputArtifacts = createEmployeeInputArtifactStore(
    join(appHome, 'artifacts', 'employee-inputs'),
  )
  const developmentDelivery = buildDevelopmentDeliveryDeps(deps.db, deps.secretBox)
  // 装配已上移到 `createApp`（RFC-317 T54）——本函数每进程跑两遍，不该装配任何东西。
  const repositoryTransportModule = deps.repositoryTransport ?? null
  const repositoryTransportCoordinator =
    repositoryTransportModule === null
      ? null
      : {
          participant: repositoryTransportModule.adminConnections,
          project: buildRepositoryTransportConnectionProjection,
        }
  if (repositoryTransportModule !== null) {
    reconcileRepositoryTransportConnectionProjections(
      deps.db,
      repositoryTransportModule.adminConnections,
    )
  }
  const codeHostConnections =
    deps.secretBox === undefined || repositoryTransportCoordinator === null
      ? null
      : createCodeHostConnectionsService({
          db: deps.db,
          secretBox: deps.secretBox,
          repositoryTransport: repositoryTransportCoordinator,
        })
  const repositoryEndpointDiscovery =
    codeHostConnections === null
      ? undefined
      : createRepositoryEndpointDiscovery({
          resolveConnection(provider) {
            const connection = codeHostConnections.resolve(provider)
            if (connection?.connectionGeneration === undefined) return null
            return {
              provider: connection.provider,
              apiBaseUrl: connection.baseUrl,
              connectionGeneration: connection.connectionGeneration,
              token: connection.token,
              rejectUnauthorized: connection.rejectUnauthorized,
            }
          },
          ...(deps.codeHostFetch === undefined ? {} : { fetchImpl: deps.codeHostFetch }),
        })
  const repositoryPublicationTransport = createRepositoryPublicationTransport({
    db: deps.db,
    ...(deps.secretBox === undefined ? {} : { secretBox: deps.secretBox }),
    appHome,
    ...(repositoryEndpointDiscovery === undefined
      ? {}
      : { endpointDiscovery: repositoryEndpointDiscovery }),
  })
  const approvalGateway = composeApprovalGatewayRunner(deps.db)
  const developmentWorkspace = composeDevelopmentEmployeeWorkspace({
    db: deps.db,
    appHome,
    reactionRounds: createEmployeeReactionRoundQueries(deps.db),
    inputArtifacts,
    sourceControl: bindEmployeeCaseWorkspaceParticipant({
      publicationTransport: repositoryPublicationTransport,
    }),
    conflictMerge: bindConflictMergeParticipant(),
  })
  const executionContracts = composeExecutionContract({
    db: deps.db,
    appHome,
    registrations: developmentExecutionContractRegistrations,
    implicitAgentDeclarations: developmentImplicitAgentContractDeclarations,
  })
  const eventCenter = deps.digitalEmployeeEventCenter ?? composeApplicationEventCenter(deps)
  const digitalEmployee = composeDigitalEmployee({
    db: deps.db,
    appHome,
    typePackages: [developmentEmployeeTypePackage],
    typePackageDriftPolicy: deps.digitalEmployeeTypePackageDriftPolicy,
    platformTools: composeDigitalEmployeeBuiltinToolCatalog({
      db: deps.db,
      typePackageDescriptorJsons: [
        ...readPersistedDigitalEmployeeTypePackageDescriptorJsons(deps.db),
        developmentEmployeeTypePackage.descriptorJson,
      ],
    }),
    executionContracts,
    retryLimits: {
      current() {
        const config = loadConfig(deps.configPath)
        return {
          defaultNodeRetries: config.defaultNodeRetries,
          sessionRestartBudget: config.sessionRestartBudget,
        }
      },
    },
    inputArtifacts,
    connectionCatalog: composeDevelopmentToolConnectionCatalog(deps.db),
    runtime: {
      eventCenter: eventCenter.participant,
      codecs: [developmentEmployeeRuntimeCodec],
      execution: createReactionExecutionAdapter(
        composeDigitalEmployeeExecution({
          db: deps.db,
          appHome,
          startDeps: buildStartTaskDeps(deps.db, deps.configPath, SYSTEM_USER_ID, deps.secretBox),
          workspace: developmentWorkspace,
          executionContracts,
        }),
      ),
      platformWorkItems: composeDevelopmentEmployeePlatformWorkItems({
        reactionRounds: createEmployeeReactionRoundQueries(deps.db),
        db: deps.db,
        appHome,
        approvalGateway,
        ...developmentDelivery,
        conflictMerge: bindConflictMergeParticipant(),
        sourceControl: {
          ...bindChangeCandidateParticipant(),
          ...bindCandidateDeliveryParticipant({
            publicationTransport: repositoryPublicationTransport,
          }),
          ...bindEmployeeCaseWorkspaceParticipant({
            publicationTransport: repositoryPublicationTransport,
          }),
        },
      }),
    },
  })
  if (deps.digitalEmployeeWorkStart !== undefined && digitalEmployee.runtime !== null) {
    deps.digitalEmployeeWorkStart.bind({
      launch(input) {
        const result = digitalEmployee.runtime!.commands.launchWork({
          employeeId: input.employeeId,
          intake: input.intake,
          actorUserId: input.actorUserId,
          eventOrigin: input.origin,
        })
        return { caseId: result.caseRef.id }
      },
    })
  }
  if (digitalEmployee.runtime === null) {
    throw new Error('task catalog requires the digital employee runtime')
  }
  const taskCatalog = composeTaskCatalog({
    sources: [
      ...composeTaskExecutionCatalogSources(deps.db),
      composeDigitalEmployeeTaskCatalogSource(digitalEmployee.runtime),
    ],
  })

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
  mountTaskCatalogRoutes(app, taskCatalog)
  mountTaskArchiveRoutes(app, deps) // RFC-311 T19
  mountMaintenanceDiskRoutes(app, deps) // RFC-311 T20
  mountScheduledTaskRoutes(app, deps) // RFC-159
  mountWebhookEndpointRoutes(app, deps) // RFC-257 T7
  mountCodeHostRoutes(app, deps, codeHostConnections) // RFC-269
  if (repositoryTransportModule !== null) {
    mountAccountRepositoryTransportCredentialRoutes(app, deps, {
      credentials: repositoryTransportModule.ownCredentials,
      currentSubjects: identityAccess.resolveAuthority,
    })
  }
  mountCodeRoutes(app, deps) // RFC-304 T31b
  mountCapabilityTemplateRoutes(app, deps) // RFC-304 T57
  mountEventCenterRoutes(app, eventCenter) // RFC-310 shared Event Center
  mountExecutionContractRoutes(app, executionContracts) // platform deterministic IO contracts
  mountDigitalEmployeeRoutes(app, deps, digitalEmployee) // RFC-310 Digital Employee OS
  mountDevelopmentConfigRoutes(app, deps) // RFC-310 PR-1B
  mountDevelopmentMissionRoutes(app, deps, {
    legacyAdmissionsEnabled: () => readDigitalEmployeeWriterState(deps.db).legacyAdmissionsEnabled,
    repositoryPublicationTransport,
  }) // RFC-310 legacy drain facade
  mountMissionInputUploadRoutes(app, deps) // RFC-310 PR-3
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
  mountAuthRoutes(app, deps, identityAccess)
  mountOidcAuthRoutes(app, deps)
  mountOidcRoutes(app, deps)
  mountUserRoutes(app, deps, identityAccess)
  mountDocsRoutes(app, deps) // RFC-247 D17
}
