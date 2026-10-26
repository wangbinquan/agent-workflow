import { selectedDatabaseConfiguration } from '@/platform/persistence/databaseProviderRuntime'
import {
  classifyEpochInstallation,
  epochInstallationGuidance,
  readEpochBootFacts,
} from '@/modules/system-operations/composition/epochBootAdmission'
import { schemaHistoryRuntime } from '@/platform/persistence/schema/history/runtime'
// `agent-workflow start` — daemon foreground entry.
import type { DeploymentProfile } from './deploymentProfile'
import type { DevelopmentOverlay } from './developmentReload'
import { composeDaemonSession } from './daemonSession'
import type { AuthRuntime } from '@/auth/application/authRuntime'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import {
  selectWorkspaceUploadContentFactory,
  selectIsolationWorkspaceFactory,
  selectRepositoryGitWorkspaceFactory,
} from '@/modules/source-control/public/participants'
import { composeApplicationConfigurationBinding } from '@/modules/system-operations/composition/applicationConfiguration'

import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { createSecretBox } from '@/auth/secretBox'
import { createExecutionExitRequests } from './executionActivation'
import { ensureTokenFile } from '@/auth/token'
import { schemaDriftGuidance } from '@/modules/system-operations/composition/schemaDriftGuidance'
import { IS_EMBEDDED } from '@/embed'
import {
  applyLocalEpoch2PendingRestore,
  composeDaemonHostApplication,
  composeDaemonStartupLease,
  runDaemonStartupWithLease,
  type DaemonStartupLease,
} from '@/modules/system-operations/composition'
import { prepareDaemonDatabaseProviderForBoot } from '@/modules/system-operations/composition/daemonDatabase'
import { configureLogger, createLogger, type LogLevel } from '@/util/log'
import { Paths } from '@/util/paths'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { logicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { createDatabaseMigrationDaemonAdmission } from '@/modules/system-operations/composition'
import {
  composeDaemonProviderBootstrap,
  type DaemonProviderBootstrap,
} from './daemonProviderBootstrap'
import { describeDaemonProviderSessionFailure } from './daemonProviderSession'
import {
  selectDaemonHostLifecycle,
  type DaemonHostLifecyclePort,
} from '@/modules/system-operations/composition/daemonHostLifecycle'
import { selectRepositoryWorkspaceReadQueries } from '@/modules/source-control/public/queries'

/**
 * RFC-359 W3-T14 —— 监听器与关机序列只有一份，两个 provider 共用。
 *
 * 此前 PostgreSQL 走这里的前身 `servePostgresqlDaemon`，SQLite 在 `startCommand` 尾部另有一段
 * 手写的 `Bun.serve` + `shutdown()`——后者在 `bootstrap.stop()` 之前显式做蒸馏 worker 回收、
 * after-commit 泵注销、webhook 终态控制停机与任务优雅关停，而 PG 把同样几步放在会话的关闭
 * 参与者里。合一后只剩会话那一种放法：`shutdown()` 只做「摘 daemon info → 停监听 →
 * `bootstrap.stop()` → 收控制口与锁 → exit」，provider 专属的收尾全部在各自会话的
 * `providerCloseParticipants` 里、两侧同一组 id。
 */
export async function serveDaemon(input: {
  readonly bootstrap: Pick<
    DaemonProviderBootstrap,
    'runBusinessRequest' | 'tryUpgrade' | 'fetch' | 'websocketHandlers' | 'stop'
  >
  readonly authRuntime: Pick<AuthRuntime, 'isBootstrapRequired'>
  readonly postReady?: () => Promise<void>
  readonly databaseProvider: DatabaseProvider
  readonly token: string
  readonly bindHost: string
  readonly bindPort: number
  readonly lock: DaemonStartupLease
  readonly daemonHost: DaemonHostLifecyclePort
  readonly log: ReturnType<typeof createLogger>
  readonly exitRequests?: (requestExit: (reason: string) => void) => void
}): Promise<never> {
  const server = Bun.serve({
    // Bun --hot otherwise aliases the HTTP and control listeners when both
    // request an ephemeral port. Keep this application's reload identity distinct.
    id: `agent-workflow-http:${input.bindHost}:${input.bindPort}`,
    port: input.bindPort,
    hostname: input.bindHost,
    idleTimeout: 255,
    async fetch(request: Request, bunServer): Promise<Response> {
      return await input.bootstrap.runBusinessRequest(request, async () => {
        const upgraded = await input.bootstrap.tryUpgrade(request, bunServer)
        if (upgraded === true) return undefined as unknown as Response
        if (upgraded === false) return await input.bootstrap.fetch(request)
        return upgraded
      })
    },
    websocket: input.bootstrap.websocketHandlers,
  })
  const baseUrl = `http://${server.hostname}:${server.port}/`
  input.log.info('listening', { url: baseUrl, databaseProvider: input.databaseProvider })

  const application = composeDaemonHostApplication({
    host: input.daemonHost,
    postReady: input.postReady,
    databaseProvider: input.databaseProvider,
    log: input.log,
    describeFailure: describeDaemonProviderSessionFailure,
    readyInfo: () => ({
      // This constructor always binds TCP; the Bun Server type also covers Unix sockets.
      host: server.hostname!,
      port: server.port!,
      url: baseUrl,
      startedAt: new Date().toISOString(),
    }),
    readBootstrapRequired: () => input.authRuntime.isBootstrapRequired(),
    readyBrowserUrl: (bootstrapRequired) =>
      readyBrowserUrl(baseUrl, input.token, bootstrapRequired),
    async stopListener() {
      await server.stop(true)
    },
    async stopApplication() {
      await input.bootstrap.stop()
    },
    releaseAuthority: () => input.lock.release(),
    releaseAuthorityOnExit: () => input.lock.releaseOnExit(),
    ...(input.exitRequests === undefined ? {} : { exitRequests: input.exitRequests }),
  })
  return await application.run()
}

const MAX_DEV_LOCK_HANDOFF_MS = 60_000

function devLockHandoffMs(): number {
  const raw = process.env.AGENT_WORKFLOW_DEV_LOCK_HANDOFF_MS
  if (raw === undefined) return 0
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0
  return Math.min(parsed, MAX_DEV_LOCK_HANDOFF_MS)
}

/**
 * Bun --watch keeps the old generation alive until its replacement is ready.
 * A daemon cannot become ready while the old generation owns the PID lock, so
 * waiting alone deadlocks. Dev daemons advertise handoff eligibility in their
 * authenticated loopback control file; the replacement asks that exact PID to
 * drain, then waits for its lock. Normal `start` daemons never opt in and retain
 * the fail-fast singleton contract.
 */

interface DbCorruptionFailure extends Error {
  readonly dbPath: string
  readonly checkErrors: readonly string[]
}

function isDbCorruptionFailure(error: unknown): error is DbCorruptionFailure {
  return (
    error instanceof Error &&
    error.name === 'DbCorruptionError' &&
    'dbPath' in error &&
    typeof error.dbPath === 'string' &&
    'checkErrors' in error &&
    Array.isArray(error.checkErrors) &&
    error.checkErrors.every((entry) => typeof entry === 'string')
  )
}

/** RFC-213 — human-facing fail-closed message: list backups + the restore command. */
function formatDbCorruptionGuidance(err: DbCorruptionFailure): string {
  const lines = [
    '',
    '✖ agent-workflow: database corruption detected — refusing to start.',
    `  db:          ${err.dbPath}`,
    `  quick_check: ${err.checkErrors.slice(0, 3).join('; ')}`,
    '',
  ]
  let backups: string[] = []
  try {
    backups = readdirSync(Paths.backupsDir)
      .filter((f) => f.endsWith('.tar.gz'))
      .map((f) => join(Paths.backupsDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  } catch {
    /* no backups dir */
  }
  if (backups.length === 0) {
    lines.push(`  No backups found under ${Paths.backupsDir}.`)
    lines.push('  If you have a backup tarball elsewhere: agent-workflow restore <tarball>')
  } else {
    lines.push('  Available backups (newest first):')
    for (const b of backups.slice(0, 5)) lines.push(`    ${b}`)
    lines.push('')
    lines.push(`  Recover with: agent-workflow restore ${backups[0]}`)
  }
  lines.push('  (Last resort, unsafe: AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK=1 agent-workflow start)')
  lines.push('')
  return lines.join('\n')
}

export async function startCommand(
  profile: DeploymentProfile,
  launch: { host?: string; port?: number },
  development?: DevelopmentOverlay,
): Promise<void> {
  // 1. Logger — must come before lock so failures land in stdout/file.
  configureLogger({
    level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? 'info',
    logFile: Paths.daemonLog,
  })
  const log = createLogger('daemon')
  const digitalEmployeeTypePackageDriftPolicy: 'draft-overlay' | 'reject' =
    !IS_EMBEDDED &&
    devLockHandoffMs() > 0 &&
    process.env.AGENT_WORKFLOW_DEV_TYPE_PACKAGE_OVERLAY === '1'
      ? 'draft-overlay'
      : 'reject'

  // 2. The selected startup provider supplies exclusivity and release ACKs.
  const lock = await composeDaemonStartupLease({
    selected: profile.selections.startupLease,
    local: () => ({
      lockPath: Paths.lock,
      controlPath: Paths.controlFile,
      maxWaitMs: devLockHandoffMs(),
      log,
    }),
  })
  await runDaemonStartupWithLease(lock, async () => {
    log.info('lock acquired', lock.diagnostics)
    const daemonHost = selectDaemonHostLifecycle(development?.daemonHost, {
      infoPath: Paths.daemonInfo,
      controlPath: Paths.controlFile,
      pid: process.pid,
      devWatch: devLockHandoffMs() > 0,
    })

    // 3. Load config; honor logLevel if user set non-default in config.
    const applicationConfiguration =
      profile.selections.applicationConfiguration ??
      composeApplicationConfigurationBinding({
        kind: 'file',
        configPath: Paths.config,
      })
    const configuration = applicationConfiguration.queries
    const taskLaunchConfiguration = composeTaskLaunchConfiguration(
      profile.selections.applicationConfiguration !== undefined ||
        applicationConfiguration.synchronousQueries === undefined
        ? { kind: 'selected', queries: configuration }
        : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
    )
    let config = await configuration.read()
    if (config.logLevel !== 'info') {
      configureLogger({ level: config.logLevel })
    }
    log.info('config loaded', {
      path: Paths.config,
      language: config.language,
      theme: config.theme,
    })

    const fatal = await profile.probeHost({ log, config })
    if (fatal !== null) {
      console.error(fatal)
      await lock.release()
      process.exit(1)
    }

    if (profile.selections.databaseInstallation === undefined) {
      const installation = classifyEpochInstallation(
        readEpochBootFacts({ appHome: Paths.root, provider: config.database.provider }),
      )
      const guidance = epochInstallationGuidance(installation)
      if (guidance !== null) throw new Error(guidance)
    }
    // Classify legacy and unreconciled installations before resolving a pending restore.
    if (profile.selections.databasePreOpenRecovery) {
      await profile.selections.databasePreOpenRecovery.applyStagedRestore()
    } else if (!profile.selections.databaseInstallation) {
      await applyLocalEpoch2PendingRestore(logicalSchemaContract)
    }
    config = await configuration.read()

    // Provider-independent bootstrap secrets are needed by either selected
    // composition. They are created before opening a client, but no owner module
    // receives them until its verified provider graph is composed below.
    const secretBox = profile.selections.secretBox ?? createSecretBox(Paths.secretKeyFile)
    log.info('secret box ready', {
      keyFile:
        profile.selections.secretBox === undefined ? Paths.secretKeyFile : 'deployment-provided',
    })
    const token = ensureTokenFile(Paths.tokenFile)
    log.info('token ready', { tokenFile: Paths.tokenFile })
    // RFC-370 v2 §3.2 — crash-only execution authority: leaving active, or a
    // background set that fails to activate, drains and exits non-zero so the
    // platform restarts this instance as standby. Standalone never loses it.
    const executionExit = createExecutionExitRequests()
    profile.selections.executionAuthority?.onLost((state) => {
      log.warn('execution authority lost', { state: state.kind })
      executionExit.request(`execution-authority-${state.kind}`)
    })
    const dbVersion = schemaHistoryRuntime().head().contract.version
    // 5. DB — resolve the verified live generation before opening any provider
    // client. The pointer is authoritative; config may supply mechanism settings
    // but cannot silently select a different database.
    const preparedDatabase = await prepareDaemonDatabaseProviderForBoot({
      configuration: applicationConfiguration.databaseConfiguration,
      installation: profile.selections.databaseInstallation,
      file: {
        config: config.database,
        sqlitePath: Paths.db,
        generationPointerPath: Paths.databaseGenerationPointer,
        operationsRoot: Paths.databaseMigrationsDir,
        contract: logicalSchemaContract,
        lockPath: Paths.lock,
        lock,
        backupOnMigration: config.backupOnMigration,
        sqliteOptions: {
          synchronous: config.sqliteSynchronous,
          pageCacheMib: config.sqlitePageCacheMib,
          mmapMib: config.sqliteMmapMib,
          slowQueryMs: config.sqliteSlowQueryMs,
          skipIntegrityCheck: process.env.AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK === '1',
          developmentIntegrity: development?.developmentIntegrity,
        },
      },
    }).catch(async (err: unknown) => {
      if (isDbCorruptionFailure(err)) {
        // RFC-213 fail-closed: never serve a corrupt DB. Print the available
        // backups + the exact restore command, then exit non-zero. The DB is
        // unwritable, so this does NOT record a recovery_event.
        await lock.release()
        process.stderr.write(formatDbCorruptionGuidance(err))
        process.exit(1)
      }
      const guidance = schemaDriftGuidance(err)
      if (guidance) {
        await lock.release()
        process.stderr.write(guidance)
        process.exit(1)
      }
      throw err
    })
    config = { ...config, database: preparedDatabase.databaseConfig }
    const databaseProvider = preparedDatabase.runtime

    // dbVersion is the installed epoch-2 history version (starting at zero),
    // comparable with aw_meta_schema_history after boot applies pending history.

    // RFC-213/RFC-223: raw pre-migration safety backup BEFORE openDb applies
    // migrations. A pending migration without its rollback generation is fatal;
    // backupOnMigration=false is the operator's explicit opt-out.
    // RFC-359 W3-T16：这里没有 provider 执行分支——按 provider 查表取会话装配器，
    // bootstrap / resume / 监听全部走同一条中立序列（design §6 / §7 守卫 4）。
    const bindHost = launch.host ?? profile.listen.host ?? config.bindHost
    const bindPort = launch.port ?? profile.listen.port ?? config.bindPort ?? 0
    const lifecycle = Object.freeze({
      operationId: 'daemon-start',
      provider: databaseProvider.provider,
      generationId: databaseProvider.generation.payload.generationId,
    })
    const sessionInput = Object.freeze({
      ...profile.selections,
      requiredProvider: profile.requiredProvider,
      config,
      configuration,
      applicationConfiguration,
      taskLaunchConfiguration,
      workspaceUploads: selectWorkspaceUploadContentFactory(profile.selections.workspaceUploads),
      isolationWorkspaces: selectIsolationWorkspaceFactory(profile.selections.isolationWorkspaces),
      repositoryGitWorkspaces: selectRepositoryGitWorkspaceFactory(
        profile.selections.repositoryGitWorkspaces,
      ),
      workspaceReads: selectRepositoryWorkspaceReadQueries(profile.selections.workspaceReads),
      daemonRuntime: daemonHost,
      token,
      secretBox,
      onExecutionActivationFailure(error: unknown) {
        log.error('background activation failed', {
          error: error instanceof Error ? error.message : String(error),
        })
        executionExit.request('execution-activation-failed')
      },
      dbVersion,
      log,
      lock,
      migrationsFolder: '',
      digitalEmployeeTypePackageDriftPolicy,
    })
    const { initial, bootstrap: daemonProviderBootstrap } = await composeDaemonProviderBootstrap({
      initial: lifecycle,
      composeInitial: (bindings) =>
        composeDaemonSession({
          ...sessionInput,
          ...bindings,
          provider: databaseProvider,
          lifecycle,
        }),
      sessionFactory: {
        async create(lifecycleInput, bindings) {
          // 只有迁移目标才会被重新装配；源 provider（SQLite）在割接后退役，不能再被当作
          // 新会话的来源——判据取自 provider 特征表，不在这里写 provider 字面量。
          if (!supportsProviderMove(databaseProvider.provider, lifecycleInput.provider)) {
            throw new Error('provider-session-source-retired')
          }
          const nextConfig = await configuration.read()
          const nextProvider = resolveDatabaseProviderRuntime({
            config: nextConfig.database,
            sqlitePath: Paths.db,
            generationPointerPath: Paths.databaseGenerationPointer,
            operationsRoot: Paths.databaseMigrationsDir,
            contract: logicalSchemaContract,
          })
          if (
            nextProvider.provider !== lifecycleInput.provider ||
            nextProvider.generation.payload.generationId !== lifecycleInput.generationId
          ) {
            await nextProvider.close()
            throw new Error('daemon-provider-target-generation-mismatch')
          }
          return (
            await composeDaemonSession({
              ...sessionInput,
              ...bindings,
              config: {
                ...nextConfig,
                database: selectedDatabaseConfiguration(
                  nextConfig.database,
                  nextProvider.generation,
                ),
              },
              provider: nextProvider,
              lifecycle: lifecycleInput,
            })
          ).session
        },
      },
      createMigrationAdmission: createDatabaseMigrationDaemonAdmission,
    })
    await initial.session.resume(lifecycle)
    await serveDaemon({
      bootstrap: daemonProviderBootstrap,
      authRuntime: initial.application.core.authRuntime,
      postReady: () => initial.session.postReady?.() ?? Promise.resolve(),
      databaseProvider: databaseProvider.provider,
      token,
      bindHost,
      bindPort,
      lock,
      daemonHost,
      log,
      exitRequests: executionExit.subscribe,
    })
  })
}

export function readyBrowserUrl(
  baseUrl: string,
  token: string,
  bootstrapRequired: boolean,
): string {
  return bootstrapRequired ? `${baseUrl}?token=${token}` : baseUrl
}
import { supportsProviderMove } from '@/platform/persistence/migrationSupport'
