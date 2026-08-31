// RFC-346 — bootstrap-only System Operations composition.

import { join } from 'node:path'
import { createSecretBox, type SecretBox } from '@/auth/secretBox'
import { openDb, type DbClient } from '@/db/client'
import { resolveMigrationsFolder } from '@/util/migrationsFolder'
import { Paths } from '@/util/paths'
import {
  createSystemOperationsApplication,
  type SystemOperationsApplication,
} from './application/systemOperations'
import type { AdminBackupCoordinatorPort } from './application/ports/adminBackupCoordinator'
import type { AdminRestoreCoordinatorPort } from './application/ports/adminRestoreCoordinator'
import { createLegacyPlatformRecoveryAdapter } from './infrastructure/legacyPlatformRecoveryAdapter'
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

export interface SystemOperationsModule {
  readonly application: SystemOperationsApplication
  readonly operations: SystemOperationDescriptors
  readonly artifacts: RestoreArtifactIngressHandle
}

export interface SystemOperationsRecoveryAdapter {
  readonly backup: AdminBackupCoordinatorPort
  readonly restore: AdminRestoreCoordinatorPort
}

export function composeSystemOperations(deps: {
  readonly db: DbClient
  readonly secretBox: SecretBox | undefined
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
    backupResources: () => ({ db: deps.db, secretBox: deps.secretBox }),
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

export interface LocalSystemOperations {
  readonly context: LocalSystemOperationContext
  readonly requestBackup: RequestBackupCommand
  readonly planLocalRestore: PlanLocalRestoreQuery
  readonly stageRestore: StageRestoreCommand
  readonly activateLocalRestore: ActivateLocalRestoreCommand
  prepareRestoreArtifact(path: string): Promise<RestoreArtifactRef>
  releaseRestoreArtifact(ref: RestoreArtifactRef): void
}

export function composeLocalSystemOperations(): LocalSystemOperations {
  const appHome = Paths.root
  const artifacts = createRestoreArtifactIngress({
    uploadRoot: join(appHome, '.restore-upload'),
  })
  let restoreMigrations: Promise<string> | undefined
  const resolveRestoreMigrations = (): Promise<string> => {
    restoreMigrations ??= resolveMigrationsFolder({ force: true })
    return restoreMigrations
  }
  const adapter = createLegacyPlatformRecoveryAdapter({
    artifacts,
    appHome,
    dbPath: Paths.db,
    lockPath: Paths.lock,
    async backupResources() {
      const db = openDb({
        path: Paths.db,
        migrationsFolder: await resolveMigrationsFolder(),
      })
      return { db, secretBox: createSecretBox(Paths.secretKeyFile) }
    },
    resolveRestoreMigrations,
  })
  const module = composeSystemOperationsWithArtifacts({ artifacts, adapter })
  const context = Object.freeze({}) as LocalSystemOperationContext

  const localOperations: LocalSystemOperations = {
    context,
    requestBackup: module.application.commands.requestBackup,
    planLocalRestore: module.application.queries.planLocalRestore,
    stageRestore: module.application.commands.stageRestore,
    activateLocalRestore: module.application.commands.activateLocalRestore,
    async prepareRestoreArtifact(path) {
      await resolveRestoreMigrations()
      return artifacts.ingestLocalPath(path)
    },
    releaseRestoreArtifact(ref) {
      artifacts.release(ref)
    },
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
  })
}
