import { selectedDatabaseConfiguration } from '@/platform/persistence/databaseProviderRuntime'
import { prepareEpoch2DatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import { recoverEpoch2ProviderMove } from './infrastructure/local/epoch2ProviderMoveRecovery'
import { admitEpochBoot } from './composition/epochBootAdmission'
import { acquireLock } from '@/util/lock'
import { dirname } from 'node:path'
import type {
  DaemonStartupLease,
  DaemonStartupLeasePort,
} from './application/ports/daemonStartupLease'
import {
  acquireDaemonStartupLease,
  readDaemonStartupRecoveryAuthority,
  runDaemonStartupWithLease,
} from './application/daemonStartupLease'
import {
  createNativeDaemonStartupLease,
  type NativeDaemonStartupLeaseOptions,
} from './infrastructure/local/nativeDaemonStartupLease'

export type { DaemonStartupLease, DaemonStartupLeasePort }
export { readDaemonStartupRecoveryAuthority, runDaemonStartupWithLease }

/** Only the chosen provider is created; a selected failure never falls back locally. */
export function composeDaemonStartupLease(input: {
  readonly selected?: DaemonStartupLeasePort
  readonly local: () => NativeDaemonStartupLeaseOptions
}): Promise<DaemonStartupLease> {
  return acquireDaemonStartupLease(input.selected ?? createNativeDaemonStartupLease(input.local()))
}

import type { DaemonHostLifecyclePort } from './application/ports/daemonHostLifecycle'
import {
  runDaemonHostApplication,
  type DaemonHostApplicationOptions,
} from './application/daemonHostApplication'

/** Bootstrap joins selected host effects with neutral listener/application lifetimes. */
export function composeDaemonHostApplication(
  input: Omit<DaemonHostApplicationOptions, 'host'> & {
    readonly host: DaemonHostLifecyclePort
  },
): Readonly<{ run(): Promise<never> }> {
  return Object.freeze({ run: () => runDaemonHostApplication(input) })
}

import type { ExecutionAuthorityPort } from './application/ports/executionAuthority'
import { executionStatusOf } from './application/executionStatus'
import { createLocalExecutionAuthority } from './infrastructure/local/localExecutionAuthority'

export { executionStatusOf }

/** A standalone daemon owns its execution; a hosted root selects its platform adapter instead. */
export function composeLocalExecutionAuthority(): ExecutionAuthorityPort {
  return createLocalExecutionAuthority()
}

import type { DatabasePreOpenRecoveryPort } from './application/ports/databasePreOpenRecovery'
import {
  prepareDatabasePreOpenRecovery as prepareSelectedDatabasePreOpenRecovery,
  type PreparedDatabasePreOpenRecovery,
} from './application/prepareDatabasePreOpenRecovery'
import { createFileDatabasePreOpenRecovery } from './infrastructure/local/fileDatabasePreOpenRecovery'
import type { PostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationSequence'

export type DaemonDatabasePreOpenRecoveryPort =
  DatabasePreOpenRecoveryPort<PostgresqlMigrationHistory>
import type { ApplicationConfigurationQueries } from './public/queries'
// RFC-370: bootstrap-only settings composition; the application has no paths.
import { createApplicationConfiguration } from './application/applicationConfiguration'
import type {
  ApplicationConfigurationDependencies,
  ApplicationConfigurationPersistencePort,
} from './application/ports/applicationConfiguration'
import { createFileApplicationConfiguration } from './infrastructure/local/fileApplicationConfiguration'
import { notifyConfigApplied } from '@/services/configAppliedListeners'
import { configureLogger } from '@/util/log'

// RFC-346 — bootstrap-only System Operations composition.

import type { DatabaseConfig } from '@agent-workflow/shared'
import { join } from 'node:path'
import type { DatabaseConfigurationPort } from './application/ports/databaseConfiguration'
import type { DatabaseInstallationPort } from './application/ports/databaseInstallation'
import { prepareDatabaseInstallation } from './application/prepareDatabaseInstallation'

import { createFileDatabaseConfiguration } from './infrastructure/local/fileDatabaseConfiguration'
import { type SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'

import type { RepositoryBackupPreparationParticipant } from '@/modules/source-control/public/participants'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  resolveDatabaseProviderRuntimeForRestore,
  type ResolvedDatabaseProviderRuntime,
  requireDatabaseConfig,
  requireDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import type {
  prepareDatabaseSchemaUpgrade,
  DatabaseSchemaUpgradeOptions,
} from './infrastructure/databaseSchemaUpgradeCoordinator'
import {
  type DatabaseProvider,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import {
  buildPostgresqlSchemaPlan,
  type PostgresqlSchemaPlan,
} from '@/platform/persistence/postgresqlSchema'
import { Paths } from '@/util/paths'
import {
  createSystemOperationsApplication,
  type SystemOperationsApplication,
} from './application/systemOperations'
import type { AdminBackupCoordinatorPort } from './application/ports/adminBackupCoordinator'
import type { AdminRestoreCoordinatorPort } from './application/ports/adminRestoreCoordinator'
import { createLegacyPlatformRecoveryAdapter } from './infrastructure/legacyPlatformRecoveryAdapter'

import { createPostgresqlAdminBackupCoordinator } from './infrastructure/postgresqlAdminBackupCoordinator'
import {
  createPostgresqlAdminRestoreCoordinator,
  type PostgresqlAdminRestoreCoordinator,
} from './infrastructure/postgresqlAdminRestoreCoordinator'
import { createPostgresqlProviderRestoreApplicationAssets } from './infrastructure/postgresqlProviderRestoreApplicationAssets'
import {
  createLiveRestoreStageInputCodec,
  createRestoreArtifactIngress,
  type RestoreArtifactIngressHandle,
  type RestoreArtifactRegistry,
} from './infrastructure/restoreArtifactIngress'
import type {
  ActivateLocalRestoreCommand,
  RequestBackupCommand,
  StageRestoreCommand,
  SystemOperationCommands,
} from './public/commands'
import {
  createSystemOperationDescriptors,
  type SystemOperationDescriptors,
} from './public/operations'
import type { PlanLocalRestoreQuery } from './public/queries'
import type { LocalSystemOperationContext, RestoreArtifactRef } from './public/types'
import type { MaintenanceSystemOperations } from './application/ports/maintenanceSystemOperations'
import { createSystemOperationsMaintenanceJobHandlers as createSystemJobHandlers } from './application/maintenanceJobs'
import { pruneLocalBackups } from './infrastructure/local/localBackupPrune'

export { readDatabaseSchemaUpgradeGeneration } from './infrastructure/databaseMigrationCoordinator'
export {
  createDatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmissionLiveState,
} from './infrastructure/databaseMigrationDaemonAdmission'

/** Pre-open effects are selected before either history or generation is read. */
export function prepareDatabasePreOpenRecovery<THistory>(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly recovery: DatabasePreOpenRecoveryPort<THistory>
}): Promise<PreparedDatabasePreOpenRecovery<THistory>>
export function prepareDatabasePreOpenRecovery(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly recovery?: DaemonDatabasePreOpenRecoveryPort
}): Promise<PreparedDatabasePreOpenRecovery<PostgresqlMigrationHistory>>
export async function prepareDatabasePreOpenRecovery<THistory>(input: {
  readonly contract: LogicalSchemaContract
  readonly migrationsFolder: string
  readonly recovery?: DatabasePreOpenRecoveryPort<THistory>
}): Promise<
  | PreparedDatabasePreOpenRecovery<THistory>
  | PreparedDatabasePreOpenRecovery<PostgresqlMigrationHistory>
> {
  const recovery = input.recovery
  if (recovery !== undefined) {
    return await prepareSelectedDatabasePreOpenRecovery({
      contract: input.contract,
      effects: recovery,
    })
  }
  return await prepareSelectedDatabasePreOpenRecovery({
    contract: input.contract,
    effects: createFileDatabasePreOpenRecovery({
      contract: input.contract,
      migrationsFolder: input.migrationsFolder,
    }),
  })
}

/** Boot/manual-command preparation; the returned provider owns the prepared mechanism. */
export interface SelectedDatabaseBootPreparation<TPrepared> {
  readonly config: DatabaseConfig
  readonly contract: LogicalSchemaContract
  readonly configuration: DatabaseConfigurationPort
  readonly installation: DatabaseInstallationPort<TPrepared>
}

type FileDatabaseBootPreparation = Omit<
  DatabaseSchemaUpgradeOptions,
  'readConfig' | 'writeConfig'
> &
  (
    | { readonly configuration: DatabaseConfigurationPort; readonly configPath?: never }
    | { readonly configuration?: never; readonly configPath?: string }
  )

type PreparedFileDatabase = Awaited<ReturnType<typeof prepareDatabaseSchemaUpgrade>>

export function prepareDatabaseProviderForBoot<TPrepared>(
  input: SelectedDatabaseBootPreparation<TPrepared>,
): Promise<TPrepared>
export function prepareDatabaseProviderForBoot(
  input: FileDatabaseBootPreparation,
): Promise<PreparedFileDatabase>
export async function prepareDatabaseProviderForBoot<TPrepared>(
  input: SelectedDatabaseBootPreparation<TPrepared> | FileDatabaseBootPreparation,
): Promise<TPrepared | PreparedFileDatabase> {
  if ('installation' in input) {
    return await prepareDatabaseInstallation({
      config: input.config,
      contract: input.contract,
      configuration: input.configuration,
      effects: input.installation,
    })
  }
  let held: ReturnType<typeof acquireLock> | undefined
  const requireUpgradeLock = () => {
    if (input.lock === undefined && held === undefined) held = acquireLock(input.lockPath)
  }
  try {
    admitEpochBoot({
      appHome: dirname(input.generationPointerPath),
      provider: input.config.provider,
    })
    await recoverEpoch2ProviderMove({ ...input, requireUpgradeLock })
    return await prepareEpoch2DatabaseProviderRuntime({ ...input, requireUpgradeLock })
  } finally {
    held?.release()
  }
}

export interface SystemOperationsModule {
  readonly application: SystemOperationsApplication
  readonly operations: SystemOperationDescriptors
  readonly artifacts: RestoreArtifactIngressHandle
  /** Bootstrap-only authority for unattended local maintenance commands. */
  readonly localContext: LocalSystemOperationContext
}

export interface SystemOperationsRecoveryAdapter {
  readonly backup: AdminBackupCoordinatorPort
  readonly restore: AdminRestoreCoordinatorPort
}

export interface PostgresqlSystemOperationsModule extends SystemOperationsModule {
  /** Boot-only cold-restore hook. Bootstrap calls it before opening business admission. */
  applyPendingRestore(): Promise<boolean>
}

function bindRepositoryBackupPreparation(
  participant: RepositoryBackupPreparationParticipant,
): () => Promise<void> {
  return async () => {
    await participant.prepare({ blockOnCredentialedPath: true })
  }
}

export function composeSystemOperations(deps: {
  readonly contract: LogicalSchemaContract
  readonly db: DbClient
  readonly secretBox: SecretBox | undefined
  /** Bootstrap-bound Source Control backup preparation participant. */
  readonly repositoryBackupPreparation: RepositoryBackupPreparationParticipant
  readonly appHome?: string
  readonly dbPath?: string
  readonly lockPath?: string
  readonly resolveRestoreMigrations?: () => Promise<string>
}): SystemOperationsModule {
  const appHome = deps.appHome ?? Paths.root
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  const adapter = createLegacyPlatformRecoveryAdapter({
    contract: deps.contract,
    artifacts,
    appHome,
    dbPath: deps.dbPath ?? join(appHome, 'db.sqlite'),
    lockPath: deps.lockPath ?? join(appHome, '.daemon.lock'),
    backupResources: () => ({ db: deps.db }),
    prepareBackup: bindRepositoryBackupPreparation(deps.repositoryBackupPreparation),
    resolveRestoreMigrations: deps.resolveRestoreMigrations ?? (async () => ''),
  })
  return composeSystemOperationsWithArtifacts({
    artifacts,
    adapter,
  })
}

/** Provider-aware bootstrap entrypoint. The selected provider owns physical
 * backup/restore mechanics; System Operations keeps transport/application
 * descriptors and restore-artifact ingress unchanged. */
export function composeSystemOperationsWithRecoveryAdapter(deps: {
  readonly adapter: SystemOperationsRecoveryAdapter
  readonly appHome?: string
}): SystemOperationsModule {
  const appHome = deps.appHome ?? Paths.root
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  return composeSystemOperationsWithArtifacts({ artifacts, adapter: deps.adapter })
}

/** Compose the full PostgreSQL administration surface against the already
 * verified target runtime. No SQLite handle or fallback enters this path. */
export function composePostgresqlSystemOperations(deps: {
  readonly headContract: LogicalSchemaContract
  readonly runtime: PostgresqlDatabaseRuntime
  /**
   * RFC-359 W9：备份 / 还原要读的 workflow 与 worktree 行没有 provider 差异，走中立
   * 客户端（`portableApplicationAssets.ts`）。runtime 仍然只负责真正按引擎分叉的那一半
   * ——逻辑快照 / 逻辑还原目标与 advisory lock。
   */
  readonly db: PersistenceDb
  readonly backup?: AdminBackupCoordinatorPort
  readonly databaseConfig: Extract<DatabaseConfig, { provider: 'postgresql' }>
  readonly repositoryBackupPreparation: RepositoryBackupPreparationParticipant
  readonly appHome?: string
  readonly lockPath?: string
  readonly contract: LogicalSchemaContract
  readonly plan?: PostgresqlSchemaPlan
}): PostgresqlSystemOperationsModule {
  const appHome = deps.appHome ?? Paths.root
  const contract = deps.contract
  const plan = deps.plan ?? buildPostgresqlSchemaPlan(contract)
  if (plan.contractDigest !== contract.digest) {
    throw new Error('postgresql-system-operations-schema-plan-mismatch')
  }
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  const restore: PostgresqlAdminRestoreCoordinator = createPostgresqlAdminRestoreCoordinator({
    headContract: deps.headContract,
    artifacts,
    runtime: deps.runtime,
    targetGenerationId: deps.runtime.generationId,
    targetProfileRef: `env:${deps.databaseConfig.urlEnv}`,
    appHome,
    lockPath: deps.lockPath ?? join(appHome, '.daemon.lock'),
    contract,
    plan,
    filesystem: createPostgresqlProviderRestoreApplicationAssets({
      db: deps.db,
      appHome,
      databaseConfig: deps.databaseConfig,
    }),
  })
  const module = composeSystemOperationsWithArtifacts({
    artifacts,
    adapter: {
      backup:
        deps.backup ??
        createPostgresqlAdminBackupCoordinator({
          headContract: deps.headContract,
          contract,
          runtime: deps.runtime,
          db: deps.db,
          appHome,
          prepare: bindRepositoryBackupPreparation(deps.repositoryBackupPreparation),
        }),
      restore,
    },
  })
  return Object.freeze({
    ...module,
    applyPendingRestore: () => restore.applyPending(),
  })
}

export interface LocalSystemOperations {
  readonly context: LocalSystemOperationContext
  readonly requestBackup: RequestBackupCommand
  readonly planLocalRestore: PlanLocalRestoreQuery
  readonly stageRestore: StageRestoreCommand
  readonly activateLocalRestore: ActivateLocalRestoreCommand
  prepareRestoreArtifact(path: string): Promise<RestoreArtifactRef>
  releaseRestoreArtifact(ref: RestoreArtifactRef): void
  shutdown(): Promise<void>
}

/**
 * 一个 provider 的本地系统运维装配：交出 `module` 与 `prepareRestoreArtifact` 两件东西。
 *
 * RFC-359 AC-10 第十波：这两支原来是 `composeLocalSystemOperations` 体内的一个
 * `if (provider.provider === 'postgresql') … else …`。它是账本开账时归的「**组合根装配**」
 * 那一堆——「装配期按 provider 选一次实现」本该只发生一次，而这里就是那一次，所以处方不是
 * 「把答案声明进 traits」，也不是在原地查表判品牌，而是**把两套装配各自收成一个组合根**、
 * 由一张按 `DatabaseProvider` 穷举的表选一次。
 *
 * 两支的形状本来就不同、也不该被抹平：外部服务器侧一次装好；本地库文件侧是**惰性**装配
 * （`resolveDatabase()` / `resolveRestoreMigrations()` 到用时才开库、才解析迁移目录），
 * 因为 `doctor` / `restore` 这类路径可能在库还不存在时就调到它。
 */
interface LocalSystemOperationsComposeInput {
  readonly provider: ResolvedDatabaseProviderRuntime
  readonly databaseConfig: DatabaseConfig
  readonly appHome: string
  readonly contract: LogicalSchemaContract
  readonly repositoryBackupPreparationFactory: (
    db: PersistenceDb,
  ) => RepositoryBackupPreparationParticipant
  readonly repositoryBackupPreparation?: RepositoryBackupPreparationParticipant | undefined
}

interface ComposedLocalSystemOperations {
  readonly module: SystemOperationsModule
  readonly prepareRestoreArtifact: (path: string) => Promise<RestoreArtifactRef>
}

function composePostgresqlLocalSystemOperations({
  provider,
  databaseConfig,
  appHome,
  contract,
  repositoryBackupPreparation: injectedBackupPreparation,
  repositoryBackupPreparationFactory,
}: LocalSystemOperationsComposeInput): ComposedLocalSystemOperations {
  // RFC-359 AC-10：「运行时选了这一支、配置也必须是这一支」的收窄，与紧挨着的
  // `requireDatabaseProviderRuntime` 同一层、同一个名字家族（§5fd 把它从 `cli/start.ts`
  // 的手写版搬进 `platform/persistence/`）。这里是它的第二个消费者。
  const postgresqlConfig = requireDatabaseConfig(
    selectedDatabaseConfiguration(databaseConfig, provider.generation),
    'postgresql',
  )
  const runtime = requireDatabaseProviderRuntime(provider, 'postgresql')
  const database = runtime.openClient()
  const repositoryBackupPreparation =
    injectedBackupPreparation ?? repositoryBackupPreparationFactory(database)
  const module = composePostgresqlSystemOperations({
    headContract: contract,
    runtime: runtime.runtime,
    db: database,
    databaseConfig: postgresqlConfig,
    repositoryBackupPreparation,
    appHome,
    lockPath: Paths.lock,
    contract,
  })
  const prepareRestoreArtifact = async (path: string) => module.artifacts.ingestLocalPath(path)
  return { module, prepareRestoreArtifact }
}

function composeSqliteLocalSystemOperations({
  contract,
  provider,
  appHome,
  repositoryBackupPreparation: injectedBackupPreparation,
  repositoryBackupPreparationFactory,
}: LocalSystemOperationsComposeInput): ComposedLocalSystemOperations {
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  const resolveRestoreMigrations = async (): Promise<string> => ''
  let database: DbClient | null = null
  let composedBackupPreparation: RepositoryBackupPreparationParticipant | null = null
  const sqliteRuntime = requireDatabaseProviderRuntime(provider, 'sqlite')
  const resolveDatabase = async (): Promise<DbClient> =>
    (database ??= sqliteRuntime.openClient({
      migrationsFolder: '',
    }))
  const resolveBackupPreparation = async (): Promise<RepositoryBackupPreparationParticipant> => {
    if (composedBackupPreparation !== null) return composedBackupPreparation
    composedBackupPreparation = repositoryBackupPreparationFactory(await resolveDatabase())
    return composedBackupPreparation
  }
  const repositoryBackupPreparation =
    injectedBackupPreparation ??
    Object.freeze({
      async prepare(input: Parameters<RepositoryBackupPreparationParticipant['prepare']>[0]) {
        return (await resolveBackupPreparation()).prepare(input)
      },
    })
  const adapter = createLegacyPlatformRecoveryAdapter({
    contract,
    artifacts,
    appHome,
    dbPath: sqliteRuntime.sqlitePath,
    lockPath: Paths.lock,
    async backupResources() {
      return { db: await resolveDatabase() }
    },
    prepareBackup: bindRepositoryBackupPreparation(repositoryBackupPreparation),
    resolveRestoreMigrations,
  })
  const module = composeSystemOperationsWithArtifacts({ artifacts, adapter })
  const prepareRestoreArtifact = async (path: string) => {
    await resolveRestoreMigrations()
    return module.artifacts.ingestLocalPath(path)
  }
  return { module, prepareRestoreArtifact }
}

/** 按 provider 查表；表按 `DatabaseProvider` 穷举，少一个 provider 就编译不过。 */
const LOCAL_SYSTEM_OPERATIONS_COMPOSERS = {
  postgresql: composePostgresqlLocalSystemOperations,
  sqlite: composeSqliteLocalSystemOperations,
} satisfies Record<
  DatabaseProvider,
  (input: LocalSystemOperationsComposeInput) => ComposedLocalSystemOperations
>

export function composeLocalSystemOperations(deps: {
  readonly repositoryBackupPreparationFactory: (
    db: PersistenceDb,
  ) => RepositoryBackupPreparationParticipant
  readonly contract: LogicalSchemaContract
  readonly repositoryBackupPreparation?: RepositoryBackupPreparationParticipant
  readonly databaseConfig?: DatabaseConfig
  readonly providerRuntime?: ResolvedDatabaseProviderRuntime
}): LocalSystemOperations {
  const appHome = Paths.root
  const databaseConfig = deps.databaseConfig ?? createFileDatabaseConfiguration(Paths.config).read()
  const contract = deps.contract
  const provider =
    deps.providerRuntime ??
    resolveDatabaseProviderRuntimeForRestore({
      config: databaseConfig,
      sqlitePath: Paths.db,
      generationPointerPath: Paths.databaseGenerationPointer,
      operationsRoot: Paths.databaseMigrationsDir,
      contract,
    })
  const { module, prepareRestoreArtifact } = LOCAL_SYSTEM_OPERATIONS_COMPOSERS[provider.provider]({
    provider,
    databaseConfig,
    appHome,
    contract,
    repositoryBackupPreparation: deps.repositoryBackupPreparation,
    repositoryBackupPreparationFactory: deps.repositoryBackupPreparationFactory,
  })
  const context = Object.freeze({}) as LocalSystemOperationContext

  const localOperations: LocalSystemOperations = {
    context,
    requestBackup: module.application.commands.requestBackup,
    planLocalRestore: module.application.queries.planLocalRestore,
    stageRestore: module.application.commands.stageRestore,
    activateLocalRestore: module.application.commands.activateLocalRestore,
    prepareRestoreArtifact,
    releaseRestoreArtifact(ref) {
      module.artifacts.release(ref)
    },
    shutdown: () => provider.close(),
  }
  return Object.freeze(localOperations)
}

function composeSystemOperationsWithArtifacts(deps: {
  readonly artifacts: RestoreArtifactRegistry
  readonly adapter: SystemOperationsRecoveryAdapter
}): SystemOperationsModule {
  const application = createSystemOperationsApplication(deps.adapter)
  const httpCommands: SystemOperationCommands = Object.freeze({
    ...application.commands,
    stageRestore: Object.freeze({
      async execute(
        context: Parameters<StageRestoreCommand['execute']>[0],
        input: Parameters<StageRestoreCommand['execute']>[1],
      ) {
        try {
          return await application.commands.stageRestore.execute(context, input)
        } finally {
          deps.artifacts.release(input.artifactRef)
        }
      },
    }),
  })
  return Object.freeze({
    application,
    operations: createSystemOperationDescriptors({
      commands: httpCommands,
      queries: application.queries,
      stageRestoreInput: createLiveRestoreStageInputCodec(deps.artifacts),
    }),
    artifacts: deps.artifacts,
    localContext: Object.freeze({}) as LocalSystemOperationContext,
  })
}

export function composeApplicationConfiguration(deps: ApplicationConfigurationDependencies) {
  return createApplicationConfiguration(deps)
}

export function composeFileApplicationConfiguration(
  input: Omit<Parameters<typeof composeApplicationConfiguration>[0], 'persistence' | 'applied'> & {
    readonly configPath: string
  },
) {
  const { configPath, ...deps } = input
  const persistence: ApplicationConfigurationPersistencePort =
    createFileApplicationConfiguration(configPath)
  return composeApplicationConfiguration({
    ...deps,
    persistence,
    applied: {
      notify: (config) => notifyConfigApplied(configPath, config),
      setLogLevel: (level) => configureLogger({ level }),
    },
  })
}

/** Standalone configuration reads retain the file adapter's live-read semantics. */
export function composeFileApplicationConfigurationQueries(
  configPath: string,
): ApplicationConfigurationQueries {
  const persistence = createFileApplicationConfiguration(configPath)
  return Object.freeze({ read: () => persistence.load() })
}

export { schemaContribution } from './composition/schema'

export { createResourceLimitAudit } from './infrastructure/resourceLimitAudit'

export async function applyLocalEpoch2PendingRestore(
  contract: LogicalSchemaContract,
): Promise<boolean> {
  return createFileDatabasePreOpenRecovery({ contract, migrationsFolder: '' }).applyStagedRestore()
}

export { composeMaintenanceSystemOperations } from './infrastructure/maintenanceSystemOperations'

// RFC-399 B1: bootstrap's maintenance job table takes these handlers via composition; the
// standalone backup-directory fallback is local infrastructure injected here.
export type { MaintenanceSystemOperations } from './application/ports/maintenanceSystemOperations'
export function createSystemOperationsMaintenanceJobHandlers(
  system: MaintenanceSystemOperations,
): ReturnType<typeof createSystemJobHandlers> {
  return createSystemJobHandlers(system, { prune: pruneLocalBackups })
}
