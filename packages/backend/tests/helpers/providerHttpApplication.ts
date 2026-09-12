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
import type { TaskExecutionReadModels } from '@/modules/task-execution/public/types'
import type { CollaborationRouteContext } from '@/modules/collaboration/public/types'
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
  /**
   * 守护进程级并发池的 scope key（`getNodePoolSemaphore` / `resizeAllNodePools` 的第一个实参）。
   *
   * 它**按 provider 不同**：SQLite 侧用 `db`（运行时参与者的 `processConcurrencyScope: input.db`
   * 与 `server.ts` 的 `composeLegacyConfigConcurrencyHotApply(deps.db)`），PostgreSQL 侧用
   * `provider.runtime`（`cli/postgresqlDaemonApplication.ts` 的 `processConcurrencyScope` 与同
   * 文件的 `concurrencyHotApply`）。两处 file:line 用 `grep -rn processConcurrencyScope src/` 即得
   * ——这里不写死行号，避免把一句注释算成一次「对 SQLite 适配器的引用」而让成对覆盖账本失真。
   * 两侧各自内部一致——配置路由与任务引擎用的是同一个 key，所以池在两个 provider 上都能正确
   * 热应用。**不一致的是用例**：直接拿 `harness.db` 当 key 只在 SQLite 上成立，在 PG 上取到的
   * 是另一个命名空间里的空池，于是「PUT /api/config 应当当场改容量」的判据静默失效。
   * 要检查池就从这里取。
   */
  readonly processConcurrencyScope: object
  readonly repositoryWorkspaceStore: RepositoryWorkspaceStore
  /**
   * 应用**自己装配好**的任务执行读模型。
   *
   * RFC-359 —— 合一前一批用例为了拿到它，在外面再 `createTaskExecutionReadModels(db)` 建一份
   * 一模一样的，再从 `AppDeps.taskExecutionReadModels` 塞回去（`rfc340-review-access` /
   * `rfc314-session-view-window` / `rfc311-session-view-bounded` 等）。那个形状把用例钉死在
   * SQLite 上——`PostgresqlApplicationInput` 没有、也不该有这个只服务测试的字段。
   * 两个 provider 本来都已经装配了它（SQLite 的 `SqliteAppComposition.taskExecutionReadModels`、
   * PostgreSQL 的 `taskExecutionProvider.readModels`），这里只是把结果交出来。
   */
  readonly taskExecutionReadModels: TaskExecutionReadModels
  /** 同上：应用**自己装配好**的协作命令上下文，别在外面再建一份。 */
  readonly collaborationContext: CollaborationRouteContext
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
      taskExecutionReadModels: composed.taskExecutionReadModels,
      collaborationContext: composed.collaborationContext,
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
  let taskExecutionReadModels: TaskExecutionReadModels
  let collaborationContext: CollaborationRouteContext
  let taskExecution: ProviderHttpApplication['taskExecution']
  let processConcurrencyScope: object
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
      taskExecutionReadModels = sqliteApplication.taskExecutionReadModels
      collaborationContext = sqliteApplication.collaborationContext
      taskExecution = Object.freeze({ provider: 'sqlite' })
      processConcurrencyScope = binding.db
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
      taskExecutionReadModels = postgresqlApplication.runtime.taskExecution.readModels
      collaborationContext = postgresqlApplication.runtime.collaborationContext
      processConcurrencyScope = binding.runtime
      taskExecution = Object.freeze({
        provider: 'postgresql',
        selected: postgresqlApplication.runtime.taskExecution,
        workspace: postgresqlApplication.runtime.workspaceMaintenance,
      })
    }
    return Object.freeze({
      app: application.app,
      secretBox,
      processConcurrencyScope,
      repositoryWorkspaceStore,
      taskExecutionReadModels,
      collaborationContext,
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
