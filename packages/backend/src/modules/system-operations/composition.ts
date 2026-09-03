// RFC-346 — bootstrap-only System Operations composition.

import type { DatabaseConfig } from '@agent-workflow/shared'
import { join } from 'node:path'
import { createSecretBox, type SecretBox } from '@/auth/secretBox'
import { loadConfig } from '@/config'
import type { DbClient } from '@/db/client'
import { composeSqliteFusionPersistence } from '@/modules/knowledge-evolution/composition/fusion'
import type { RepositoryBackupPreparationParticipant } from '@/modules/source-control/public/participants'
import {
  composePostgresqlRepositoryWorkspaceStore,
  composeRepositoryWorkspaceOperations,
  composeSqliteRepositoryWorkspaceStore,
} from '@/modules/source-control/composition'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { resolveDatabaseProviderRuntime } from '@/platform/persistence/databaseProviderRuntime'
import {
  buildLogicalSchemaContract,
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

export { createPostgresqlHealthDatabaseReadModel } from './infrastructure/postgresqlHealthReadModel'
export {
  createDatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmission,
  type DatabaseMigrationDaemonAdmissionLiveState,
} from './infrastructure/databaseMigrationDaemonAdmission'

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
      await repairFusionProvenance(composeSqliteFusionPersistence({ db, appHome }))
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
      runtime: deps.runtime,
      appHome,
      databaseConfig: deps.databaseConfig,
    }),
  })
  const module = composeSystemOperationsWithArtifacts({
    artifacts,
    adapter: {
      backup: createPostgresqlAdminBackupCoordinator({
        runtime: deps.runtime,
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

export function composeLocalSystemOperations(
  deps: {
    readonly repositoryBackupPreparation?: RepositoryBackupPreparationParticipant
    readonly databaseConfig?: DatabaseConfig
  } = {},
): LocalSystemOperations {
  const appHome = Paths.root
  const databaseConfig = deps.databaseConfig ?? loadConfig(Paths.config).database
  const contract = buildLogicalSchemaContract()
  const provider = resolveDatabaseProviderRuntime({
    config: databaseConfig,
    sqlitePath: Paths.db,
    generationPointerPath: Paths.databaseGenerationPointer,
    operationsRoot: Paths.databaseMigrationsDir,
    contract,
  })
  let module: SystemOperationsModule
  let prepareRestoreArtifact: (path: string) => Promise<RestoreArtifactRef>
  if (provider.provider === 'postgresql') {
    if (databaseConfig.provider !== 'postgresql') {
      throw new Error('postgresql-system-operations-config-mismatch')
    }
    const database = provider.openClient()
    const repositoryBackupPreparation =
      deps.repositoryBackupPreparation ??
      composeRepositoryWorkspaceOperations(
        composePostgresqlRepositoryWorkspaceStore(database),
        createSecretBox(Paths.secretKeyFile),
      ).backupPreparation
    module = composePostgresqlSystemOperations({
      runtime: provider.runtime,
      databaseConfig,
      repositoryBackupPreparation,
      appHome,
      lockPath: Paths.lock,
      contract,
    })
    prepareRestoreArtifact = async (path) => module.artifacts.ingestLocalPath(path)
  } else {
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
    const resolveDatabase = async (): Promise<DbClient> =>
      (database ??= provider.openClient({
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
      deps.repositoryBackupPreparation ??
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
    module = composeSystemOperationsWithArtifacts({ artifacts, adapter })
    prepareRestoreArtifact = async (path) => {
      await resolveRestoreMigrations()
      return module.artifacts.ingestLocalPath(path)
    }
  }
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
