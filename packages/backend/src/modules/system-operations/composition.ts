// RFC-346 — bootstrap-only System Operations composition.

import type { DatabaseConfig } from '@agent-workflow/shared'
import { join } from 'node:path'
import { createSecretBox, type SecretBox } from '@/auth/secretBox'
import { applyConfigPatch, loadConfig } from '@/config'
import type { DbClient } from '@/db/client'
import type { ProviderNeutralDatabase } from '@/db/query'
import { composeSqliteFusionPersistence } from '@/modules/knowledge-evolution/composition/fusion'
import type { RepositoryBackupPreparationParticipant } from '@/modules/source-control/public/participants'
import {
  composePostgresqlRepositoryWorkspaceStore,
  composeRepositoryWorkspaceOperations,
  composeSqliteRepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  resolveDatabaseProviderRuntime,
  type ResolvedDatabaseProviderRuntime,
  requireDatabaseConfig,
  requireDatabaseProviderRuntime,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  prepareDatabaseSchemaUpgrade,
  type DatabaseSchemaUpgradeOptions,
} from './infrastructure/databaseSchemaUpgradeCoordinator'
import {
  buildLogicalSchemaContract,
  type DatabaseProvider,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import {
  buildPostgresqlSchemaPlan,
  type PostgresqlSchemaPlan,
} from '@/platform/persistence/postgresqlSchema'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'
import { repairFusionProvenance } from '@/modules/knowledge-evolution/public/operations'
import {
  createSystemOperationsApplication,
  type SystemOperationsApplication,
} from './application/systemOperations'
import type { AdminBackupCoordinatorPort } from './application/ports/adminBackupCoordinator'
import type { AdminRestoreCoordinatorPort } from './application/ports/adminRestoreCoordinator'
import { createLegacyPlatformRecoveryAdapter } from './infrastructure/legacyPlatformRecoveryAdapter'
import type { SqlitePostRestoreRecovery } from '@/platform/persistence/sqlite/systemProviderRestore'
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

export { createHealthDatabaseReadModel } from './infrastructure/healthReadModel'
export { readDatabaseSchemaUpgradeGeneration } from './infrastructure/databaseMigrationCoordinator'
export {
  createDatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmissionLiveState,
} from './infrastructure/databaseMigrationDaemonAdmission'
import { composeSkillMemoryFusionParticipantFactory } from '@/modules/memory/composition'
import { composeSkillVersionCommitParticipantFactory } from '@/modules/resource-catalog/composition/skillVersionCommit'

/** Boot/manual-command preparation; the returned provider owns the prepared mechanism. */
export async function prepareDatabaseProviderForBoot(
  input: Omit<DatabaseSchemaUpgradeOptions, 'readConfig' | 'writeConfig'> & {
    readonly configPath?: string
  },
) {
  const { configPath = Paths.config, ...options } = input
  return await prepareDatabaseSchemaUpgrade({
    ...options,
    readConfig: () => loadConfig(configPath).database,
    writeConfig: (database) => {
      applyConfigPatch(configPath, { database })
    },
  })
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

export function composeSqlitePostRestoreRecovery(): SqlitePostRestoreRecovery {
  return Object.freeze({
    async recover({ db, appHome }: { readonly db: DbClient; readonly appHome: string }) {
      await repairFusionProvenance(
        composeSqliteFusionPersistence({
          db,
          appHome,
          // RFC-353 T6/T7：provider 装配在 system-operation 根上完成（同 bootstrap）。
          memoryMembership: composeSkillMemoryFusionParticipantFactory(),
          skillVersionCommit: composeSkillVersionCommitParticipantFactory(),
        }),
      )
    },
  })
}

function bindRepositoryBackupPreparation(
  participant: RepositoryBackupPreparationParticipant,
): () => Promise<void> {
  return async () => {
    await participant.prepare({ blockOnCredentialedPath: true })
  }
}

export function composeSystemOperations(deps: {
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
    artifacts,
    appHome,
    dbPath: deps.dbPath ?? join(appHome, 'db.sqlite'),
    lockPath: deps.lockPath ?? join(appHome, '.daemon.lock'),
    backupResources: () => ({ db: deps.db }),
    prepareBackup: bindRepositoryBackupPreparation(deps.repositoryBackupPreparation),
    postOpenRecovery: composeSqlitePostRestoreRecovery(),
    resolveRestoreMigrations:
      deps.resolveRestoreMigrations ?? (() => resolveMigrationsFolder({ force: true })),
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
  readonly runtime: PostgresqlDatabaseRuntime
  /**
   * RFC-359 W9：备份 / 还原要读的 workflow 与 worktree 行没有 provider 差异，走中立
   * 客户端（`portableApplicationAssets.ts`）。runtime 仍然只负责真正按引擎分叉的那一半
   * ——逻辑快照 / 逻辑还原目标与 advisory lock。
   */
  readonly db: ProviderNeutralDatabase
  readonly databaseConfig: Extract<DatabaseConfig, { provider: 'postgresql' }>
  readonly repositoryBackupPreparation: RepositoryBackupPreparationParticipant
  readonly appHome?: string
  readonly lockPath?: string
  readonly contract?: LogicalSchemaContract
  readonly plan?: PostgresqlSchemaPlan
}): PostgresqlSystemOperationsModule {
  const appHome = deps.appHome ?? Paths.root
  const contract = deps.contract ?? buildLogicalSchemaContract()
  const plan = deps.plan ?? buildPostgresqlSchemaPlan(contract)
  if (plan.contractDigest !== contract.digest) {
    throw new Error('postgresql-system-operations-schema-plan-mismatch')
  }
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  const restore: PostgresqlAdminRestoreCoordinator = createPostgresqlAdminRestoreCoordinator({
    artifacts,
    runtime: deps.runtime,
    targetGenerationId: deps.runtime.generationId,
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
      backup: createPostgresqlAdminBackupCoordinator({
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
  readonly contract: ReturnType<typeof buildLogicalSchemaContract>
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
}: LocalSystemOperationsComposeInput): ComposedLocalSystemOperations {
  // RFC-359 AC-10：「运行时选了这一支、配置也必须是这一支」的收窄，与紧挨着的
  // `requireDatabaseProviderRuntime` 同一层、同一个名字家族（§5fd 把它从 `cli/start.ts`
  // 的手写版搬进 `platform/persistence/`）。这里是它的第二个消费者。
  const postgresqlConfig = requireDatabaseConfig(databaseConfig, 'postgresql')
  const runtime = requireDatabaseProviderRuntime(provider, 'postgresql')
  const database = runtime.openClient()
  const repositoryBackupPreparation =
    injectedBackupPreparation ??
    composeRepositoryWorkspaceOperations(
      composePostgresqlRepositoryWorkspaceStore(database),
      createSecretBox(Paths.secretKeyFile),
    ).backupPreparation
  const module = composePostgresqlSystemOperations({
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
  provider,
  appHome,
  repositoryBackupPreparation: injectedBackupPreparation,
}: LocalSystemOperationsComposeInput): ComposedLocalSystemOperations {
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  let restoreMigrations: Promise<string> | undefined
  const resolveRestoreMigrations = (): Promise<string> => {
    restoreMigrations ??= resolveMigrationsFolder({ force: true })
    return restoreMigrations
  }
  let database: DbClient | null = null
  let composedBackupPreparation: RepositoryBackupPreparationParticipant | null = null
  const sqliteRuntime = requireDatabaseProviderRuntime(provider, 'sqlite')
  const resolveDatabase = async (): Promise<DbClient> =>
    (database ??= sqliteRuntime.openClient({
      migrationsFolder: await resolveMigrationsFolder(),
    }))
  const resolveBackupPreparation = async (): Promise<RepositoryBackupPreparationParticipant> => {
    if (composedBackupPreparation !== null) return composedBackupPreparation
    composedBackupPreparation = composeRepositoryWorkspaceOperations(
      composeSqliteRepositoryWorkspaceStore(await resolveDatabase()),
      createSecretBox(Paths.secretKeyFile),
    ).backupPreparation
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
    artifacts,
    appHome,
    dbPath: Paths.db,
    lockPath: Paths.lock,
    async backupResources() {
      return { db: await resolveDatabase() }
    },
    prepareBackup: bindRepositoryBackupPreparation(repositoryBackupPreparation),
    postOpenRecovery: composeSqlitePostRestoreRecovery(),
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

export function composeLocalSystemOperations(
  deps: {
    readonly repositoryBackupPreparation?: RepositoryBackupPreparationParticipant
    readonly databaseConfig?: DatabaseConfig
    readonly providerRuntime?: ResolvedDatabaseProviderRuntime
  } = {},
): LocalSystemOperations {
  const appHome = Paths.root
  const databaseConfig = deps.databaseConfig ?? loadConfig(Paths.config).database
  const contract = buildLogicalSchemaContract()
  const provider =
    deps.providerRuntime ??
    resolveDatabaseProviderRuntime({
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
