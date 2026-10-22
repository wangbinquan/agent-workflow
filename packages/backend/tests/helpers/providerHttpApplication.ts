// RFC-392: every HTTP fixture enters the same application graph and owns its finite lifetime.
import { buildLogicalSchemaContract } from '@/bootstrap/persistenceSchema'
import { afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import { ALWAYS_WRITABLE_DATABASE_SOURCE } from '@/auth/application/authPersistence'
import {
  composeDaemonApplication,
  type DaemonApplication,
  type DaemonApplicationInput,
  type DaemonApplicationTestSeams,
  type UnstartedApplicationScope,
} from '@/bootstrap/daemonApplication'
import { invalidateReadConfigCache, loadConfig, saveConfigRaw } from '@/config'
import {
  composeDatabaseMigrationModule,
  type DatabaseMigrationModule,
} from '@/modules/system-operations/composition/databaseMigration'
import {
  composeApplicationConfigurationBinding,
  type ApplicationConfigurationBinding,
} from '@/modules/system-operations/composition/applicationConfiguration'
import { composeTaskLaunchConfiguration } from '@/modules/task-execution/composition/launchConfiguration'
import type { ApplicationConfigurationQueries } from '@/modules/system-operations/public/queries'
import type { DatabaseRuntimeTelemetry } from '@agent-workflow/shared'
import { createLogger } from '@/util/log'
import { composeLocalMcpDiagnostics } from '@/modules/resource-catalog/composition/localMcpDiagnostics'
import type { McpDiagnosticsRuntime } from '@/modules/resource-catalog/composition/mcpDiagnostics'
import type { ProviderDatabaseHarness, ProviderApplicationBinding } from './eachProvider'

export type ProviderHttpApplicationInput = Pick<
  DaemonApplicationInput,
  | 'token'
  | 'taskArchive'
  | 'skillContent'
  | 'employeePrograms'
  | 'employeeInputArtifacts'
  | 'missionInputBlobs'
  | 'pluginInstaller'
  | 'evidenceRead'
  | 'portArtifactContentEffects'
  | 'runtimeInventoryContent'
  | 'taskRunSelection'
  | 'developmentPurposes'
  | 'workspaceExcludeProfiles'
  | 'evidenceArtifacts'
  | 'resourcePackageSkillArtifacts'
  | 'resourcePackagePluginArtifacts'
  | 'resourcePackageSkillContent'
  | 'workspaceContent'
  | 'workspaceUploads'
  | 'workspaceReads'
  | 'repositoryCandidateEffects'
  | 'employeeCaseWorkspaceEffects'
  | 'repositoryBaselines'
  | 'verificationCommands'
  | 'automationWorkspaceEffects'
  | 'actionWorkspaceEffects'
  | 'conflictMergeWorkspaceEffects'
  | 'evidenceDocumentCommands'
  | 'daemonRuntime'
  | 'dbVersion'
  | 'maintenanceStatus'
  | 'executionAuthority'
> &
  Omit<DaemonApplicationTestSeams, 'workflowRuntime'> & {
    readonly requiredProvider?: DaemonApplicationInput['requiredProvider']
    readonly appHome?: string
    readonly configPath?: string
    readonly configuration?: ApplicationConfigurationQueries
    readonly applicationConfiguration?: ApplicationConfigurationBinding
    readonly secretBox?: SecretBox
    readonly databaseMigration?: DatabaseMigrationModule
    readonly databaseTelemetry?: () => DatabaseRuntimeTelemetry
    readonly workflowExactOperationHook?: NonNullable<
      DaemonApplicationTestSeams['workflowRuntime']
    >['workflowExactOperationHook']
    /** Configuration fields written before finite application initialization. */
    readonly config?: Readonly<Record<string, unknown>>
  }

export interface ProviderHttpApplication extends Pick<
  DaemonApplication,
  'app' | 'core' | 'modules' | 'runtime' | 'operations'
> {
  readonly appHome: string
  readonly secretBox: SecretBox
  readonly processConcurrencyScope: object
  readonly repositoryWorkspaceStore: DaemonApplication['core']['repositoryWorkspaceStore']
  readonly taskExecutionReadModels: DaemonApplication['runtime']['taskExecution']['readModels']
  readonly collaborationContext: DaemonApplication['runtime']['collaborationContext']
  readonly identityAccess: DaemonApplication['core']['identityAccess']
  readonly tokenCallAudit: DaemonApplication['core']['tokenCallAudit']
  readonly taskExecution: Readonly<{
    provider: ProviderApplicationBinding['provider']
    selected: DaemonApplication['runtime']['taskExecution']
    workspace: DaemonApplication['runtime']['workspaceMaintenance']
  }>
  dispose(): Promise<void>
}

/** Await finite module initialization and dispose only application-owned services. */
export async function composeUnstartedApplication<T extends object>(
  compose: (scope: UnstartedApplicationScope) => T | Promise<T>,
): Promise<T & { readonly dispose: () => Promise<void> }> {
  const initializations: Promise<unknown>[] = []
  const runtimeTests: McpDiagnosticsRuntime[] = []
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      const outcomes = await Promise.allSettled(runtimeTests.map((service) => service.dispose()))
      const failures = outcomes.flatMap((outcome) =>
        outcome.status === 'rejected' ? [outcome.reason] : [],
      )
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'application disposal failed')
    })()
    return disposal
  }
  const scope = Object.freeze<UnstartedApplicationScope>({
    trackReady<TReady>(ready: Promise<TReady>): Promise<TReady> {
      initializations.push(ready)
      // Composition can fail before reaching its readiness await.
      void ready.catch(() => {})
      return ready
    },
    createMcpRuntimeTests(deps) {
      const service = composeLocalMcpDiagnostics(deps)
      runtimeTests.push(service)
      return service
    },
  })
  try {
    const application = await compose(scope)
    const outcomes = await Promise.allSettled(initializations)
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'application initialization failed')
    return Object.freeze({ ...application, dispose })
  } catch (error) {
    // All finite initialization finishes before owned services are disposed.
    await Promise.allSettled(initializations)
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'application composition and disposal failed')
    }
    throw error
  }
}

/** Borrow a harness binding; the harness retains ownership of its database. */
export function createProviderHttpApplication(
  harness: ProviderDatabaseHarness,
  input: ProviderHttpApplicationInput,
): Promise<ProviderHttpApplication> {
  return createProviderHttpApplicationFromBinding(harness.applicationBinding, input)
}

/** Direct fixtures register this lifetime before their database cleanup hooks. */
export function registerProviderHttpApplicationLifetime() {
  const applications: ProviderHttpApplication[] = []
  afterEach(async () => {
    const outcomes = await Promise.allSettled(
      applications
        .splice(0)
        .reverse()
        .map((app) => app.dispose()),
    )
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason] : [],
    )
    if (failures.length > 0) throw new AggregateError(failures, 'HTTP fixture disposal failed')
  })
  return async (binding: ProviderApplicationBinding, input: ProviderHttpApplicationInput) => {
    const application = await createProviderHttpApplicationFromBinding(binding, input)
    applications.push(application)
    return application
  }
}

/** One composition call for SQLite and PostgreSQL, including former direct HTTP fixtures. */
export async function createProviderHttpApplicationFromBinding(
  binding: ProviderApplicationBinding,
  input: ProviderHttpApplicationInput,
): Promise<ProviderHttpApplication> {
  const ownedHome =
    input.appHome === undefined ? mkdtempSync(join(tmpdir(), 'aw-http-application-')) : undefined
  const appHome = input.appHome ?? ownedHome!
  const configPath = input.configPath ?? join(appHome, 'config.json')
  const originalConfig = existsSync(configPath) ? readFileSync(configPath) : null
  let application: Awaited<ReturnType<typeof compose>> | undefined
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      try {
        await application?.dispose()
      } finally {
        application?.core.identityAccess.shutdown()
        if (originalConfig === null) rmSync(configPath, { force: true })
        else writeFileSync(configPath, originalConfig)
        invalidateReadConfigCache(configPath)
        if (ownedHome !== undefined) rmSync(ownedHome, { recursive: true, force: true })
      }
    })()
    return disposal
  }
  const compose = (graphInput: DaemonApplicationInput) =>
    composeUnstartedApplication((scope) =>
      composeDaemonApplication(graphInput, { kind: 'unstarted', scope }),
    )
  try {
    const config = {
      ...loadConfig(configPath),
      ...input.config,
      database:
        binding.provider === 'sqlite' ? { provider: 'sqlite' as const } : binding.databaseConfig,
    }
    saveConfigRaw(configPath, config)
    const unexpectedAdmission = async (): Promise<never> => {
      throw new Error('provider HTTP fixture does not implement daemon migration admission')
    }
    const databaseMigration =
      input.databaseMigration ??
      composeDatabaseMigrationModule({
        contract: buildLogicalSchemaContract(),
        admission: {
          freezeAndDrain: unexpectedAdmission,
          reopenSqlite: unexpectedAdmission,
          activatePostgresql: unexpectedAdmission,
          openPostgresqlAdmission: unexpectedAdmission,
        },
        sqlitePath: join(appHome, 'db.sqlite'),
        operationsRoot: join(appHome, 'database-migrations'),
        generationPointerPath: join(appHome, 'database-generation.json'),
        configPath,
        executionMode: 'inline',
      })
    const applicationConfiguration =
      input.applicationConfiguration ??
      composeApplicationConfigurationBinding({
        kind: 'file',
        configPath,
        ...(input.configuration === undefined ? {} : { queries: input.configuration }),
      })
    const taskLaunchConfiguration = composeTaskLaunchConfiguration(
      input.applicationConfiguration !== undefined ||
        applicationConfiguration.synchronousQueries === undefined
        ? { kind: 'selected', queries: applicationConfiguration.queries }
        : { kind: 'local-sync', queries: applicationConfiguration.synchronousQueries },
    )
    const secretBox = input.secretBox ?? createSecretBoxFromKey(Buffer.alloc(32, 29))
    const provider =
      binding.provider === 'sqlite'
        ? {
            provider: 'sqlite' as const,
            telemetry:
              input.databaseTelemetry ??
              (() => ({ version: 1 as const, provider: 'sqlite' as const, poolWait: null })),
          }
        : {
            provider: 'postgresql' as const,
            runtime: binding.runtime,
            telemetry: input.databaseTelemetry ?? binding.runtime.telemetry,
          }
    const {
      buildScheduleLaunch,
      runtimeDiagnosticTestDependencies,
      webhookDispatcher,
      mcpRuntimeTestDependencies,
      intentTestDependencies,
      opencodeVersion,
      codeHostFetch,
      webhookTerminalControl,
      systemOperations,
      workflowExactOperationHook,
      ...selections
    } = input
    application = await compose({
      ...selections,
      requiredProvider: input.requiredProvider ?? null,
      db: binding.db,
      provider,
      config,
      secretBox,
      databaseMigration,
      appHome,
      configPath,
      dbPath: join(appHome, 'db.sqlite'),
      lockPath: join(appHome, '.daemon.lock'),
      daemonInfoPath: join(appHome, '.daemon.info'),
      log: createLogger('daemon'),
      applicationConfiguration,
      taskLaunchConfiguration,
      sourceWriteWindow: ALWAYS_WRITABLE_DATABASE_SOURCE,
      testSeams: {
        buildScheduleLaunch,
        runtimeDiagnosticTestDependencies,
        webhookDispatcher,
        mcpRuntimeTestDependencies,
        intentTestDependencies,
        opencodeVersion,
        codeHostFetch,
        webhookTerminalControl,
        systemOperations,
        workflowRuntime: { workflowExactOperationHook },
      },
    })
    const { core, runtime } = application
    return Object.freeze({
      app: application.app,
      appHome,
      secretBox,
      core,
      runtime,
      modules: application.modules,
      operations: application.operations,
      processConcurrencyScope: runtime.taskExecutionModules.processConcurrencyScope,
      repositoryWorkspaceStore: core.repositoryWorkspaceStore,
      taskExecutionReadModels: runtime.taskExecution.readModels,
      collaborationContext: runtime.collaborationContext,
      identityAccess: core.identityAccess,
      tokenCallAudit: core.tokenCallAudit,
      taskExecution: Object.freeze({
        provider: binding.provider,
        selected: runtime.taskExecution,
        workspace: runtime.workspaceMaintenance,
      }),
      dispose,
    })
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'HTTP fixture composition and cleanup failed')
    }
    throw error
  }
}
