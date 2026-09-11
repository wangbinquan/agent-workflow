import type { Hono } from 'hono'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createSecretBoxFromKey, type SecretBox } from '@/auth/secretBox'
import {
  composePostgresqlApplication,
  type PostgresqlApplicationInput,
} from '@/cli/postgresqlDaemonApplication'
import { invalidateReadConfigCache, loadConfig, saveConfigRaw } from '@/config'
import { composeDatabaseMigrationModule } from '@/modules/system-operations/composition/databaseMigration'
import type { RepositoryWorkspaceStore } from '@/modules/source-control/composition'
import type { SelectedPostgresqlTaskExecutionProviderRuntime } from '@/modules/task-execution/composition/providerRuntime'
import type { WorkspaceClaimFinalizationCommand } from '@/modules/source-control/public/commands'
import {
  composeSqliteApplicationDeps,
  createComposedApp,
  type AppDeps,
  type UnstartedApplicationScope,
} from '@/server'
import { McpRuntimeTestService } from '@/services/mcpRuntimeTest'
import type { ProviderDatabaseHarness } from './eachProvider'

export type ProviderHttpApplicationInput = Pick<
  AppDeps,
  'token' | 'configPath' | 'dbVersion' | 'opencodeVersion' | 'workflowExactOperationHook'
> & {
  readonly appHome: string
  /**
   * 装配前并进配置文件的字段（`plantumlEndpoint` 这类守护进程配置）。
   *
   * 为什么需要这个口子：应用读的是 `input.configPath`，而这个路径由作用域在 `open()` 里
   * 现建——用例无从提前往那个文件里写东西。合一前每份用例自建 app home、自写 config，
   * 迁到共用作用域后那份自写的 config 就被绕开了，测出来的永远是默认值（`plantuml-proxy`
   * 迁移时实测：配了端点的用例照样回 `{ unconfigured: true }`）。
   */
  readonly config?: Readonly<Record<string, unknown>>
}

export interface ProviderHttpApplication {
  readonly app: Hono
  /**
   * The very `SecretBox` the composed application was built with. Fixtures that seed
   * encrypted rows (OIDC client secrets, stored tokens) must encrypt with *this* box,
   * not a freshly keyed one — a second box decrypts to garbage against the same rows.
   */
  readonly secretBox: SecretBox
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  readonly taskExecution:
    | Readonly<{ provider: 'sqlite' }>
    | Readonly<{
        provider: 'postgresql'
        selected: SelectedPostgresqlTaskExecutionProviderRuntime
        workspace: WorkspaceClaimFinalizationCommand
      }>
  /** Close application-owned work before the harness resets its borrowed database. */
  dispose(): Promise<void>
}

/** Await finite module initialization and dispose only application-owned services. */
export async function composeUnstartedApplication<T extends object>(
  compose: (scope: UnstartedApplicationScope) => T | Promise<T>,
): Promise<T & { readonly dispose: () => Promise<void> }> {
  const initializations: Promise<unknown>[] = []
  const runtimeTests: McpRuntimeTestService[] = []
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
      const service = new McpRuntimeTestService(deps)
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

/** Test-only lifetime around the same complete composer called by the daemon. */
export function composePostgresqlUnstartedApplication(input: PostgresqlApplicationInput) {
  return composeUnstartedApplication((scope) =>
    composePostgresqlApplication(input, { kind: 'unstarted', scope }),
  )
}

/** Test-only lifetime around the same complete composer called by createApp. */
export function composeSqliteUnstartedApplication(deps: AppDeps) {
  return composeUnstartedApplication((scope) => {
    const composed = composeSqliteApplicationDeps(deps, scope)
    return {
      app: createComposedApp(composed),
      repositoryWorkspaceStore: composed.repositoryWorkspaceStore,
    }
  })
}

/**
 * Complete production application composition on the harness's actual selected
 * client and recorded pool. Module initialization is real and awaited; daemon
 * recovery and recurring work are not started. No HTTP listener is opened.
 *
 * Migration routes receive the real module, but this workflow fixture does not
 * supply daemon admission. Invoking that boundary fails explicitly and is not
 * evidence of migration behavior. The harness alone owns database cleanup.
 */
export async function createProviderHttpApplication(
  harness: ProviderDatabaseHarness,
  input: ProviderHttpApplicationInput,
): Promise<ProviderHttpApplication> {
  const binding = harness.applicationBinding
  const originalConfig = existsSync(input.configPath) ? readFileSync(input.configPath) : null
  let application: Pick<ProviderHttpApplication, 'app' | 'dispose'> | undefined
  let repositoryWorkspaceStore: RepositoryWorkspaceStore
  let taskExecution: ProviderHttpApplication['taskExecution']
  let disposal: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      try {
        await application?.dispose()
      } finally {
        if (originalConfig === null) rmSync(input.configPath, { force: true })
        else writeFileSync(input.configPath, originalConfig)
        invalidateReadConfigCache(input.configPath)
      }
    })()
    return disposal
  }

  try {
    const config = { ...loadConfig(input.configPath), ...input.config }
    const unexpectedAdmission = async (): Promise<never> => {
      throw new Error('provider HTTP fixture does not implement daemon migration admission')
    }
    const databaseMigration = composeDatabaseMigrationModule({
      admission: {
        freezeAndDrain: unexpectedAdmission,
        reopenSqlite: unexpectedAdmission,
        activatePostgresql: unexpectedAdmission,
        openPostgresqlAdmission: unexpectedAdmission,
      },
      sqlitePath: join(input.appHome, 'workflow.db'),
      operationsRoot: join(input.appHome, 'database-migrations'),
      generationPointerPath: join(input.appHome, 'database-generation.json'),
      configPath: input.configPath,
      executionMode: 'inline',
    })
    const secretBox = createSecretBoxFromKey(Buffer.alloc(32, 29))
    if (binding.provider === 'sqlite') {
      saveConfigRaw(input.configPath, { ...config, database: { provider: 'sqlite' } })
      const sqliteApplication = await composeSqliteUnstartedApplication({
        ...input,
        db: binding.db,
        secretBox,
        databaseMigration,
        daemonInfoPath: join(input.appHome, '.daemon.info'),
      })
      application = sqliteApplication
      repositoryWorkspaceStore = sqliteApplication.repositoryWorkspaceStore
      taskExecution = Object.freeze({ provider: 'sqlite' })
    } else {
      const selectedConfig = { ...config, database: binding.databaseConfig }
      saveConfigRaw(input.configPath, selectedConfig)
      const postgresqlApplication = await composePostgresqlUnstartedApplication({
        ...input,
        db: binding.db,
        provider: { runtime: binding.runtime, telemetry: binding.runtime.telemetry },
        config: selectedConfig,
        secretBox,
        databaseMigration,
        daemonInfoPath: join(input.appHome, '.daemon.info'),
        lockPath: join(input.appHome, '.daemon.lock'),
        workflowRuntime: { workflowExactOperationHook: input.workflowExactOperationHook },
      })
      application = postgresqlApplication
      repositoryWorkspaceStore = postgresqlApplication.core.repositoryWorkspaceStore
      taskExecution = Object.freeze({
        provider: 'postgresql',
        selected: postgresqlApplication.runtime.taskExecution,
        workspace: postgresqlApplication.runtime.workspaceMaintenance,
      })
    }
    return Object.freeze({
      app: application.app,
      secretBox,
      repositoryWorkspaceStore,
      dispose,
      taskExecution,
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
