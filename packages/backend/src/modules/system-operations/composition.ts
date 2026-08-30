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
import { createLegacyPlatformRecoveryAdapter } from './infrastructure/legacyPlatformRecoveryAdapter'
import {
  createRestoreArtifactIngress,
  type RestoreArtifactIngressHandle,
  type RestoreArtifactRegistry,
} from './infrastructure/restoreArtifactIngress'
import type {
  ActivateLocalRestoreCommand,
  RequestBackupCommand,
  StageRestoreCommand,
} from './public/commands'
import type { PlanLocalRestoreQuery } from './public/queries'
import type { LocalSystemOperationContext, RestoreArtifactRef } from './public/types'

export interface SystemOperationsModule {
  readonly application: SystemOperationsApplication
  readonly artifacts: RestoreArtifactIngressHandle
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
  return composeSystemOperationsWithArtifacts({
    artifacts,
    appHome,
    dbPath: deps.dbPath ?? join(appHome, 'db.sqlite'),
    lockPath: deps.lockPath ?? join(appHome, '.daemon.lock'),
    backupResources: () => ({ db: deps.db, secretBox: deps.secretBox }),
    resolveRestoreMigrations:
      deps.resolveRestoreMigrations ?? (() => resolveMigrationsFolder({ force: true })),
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
  const module = composeSystemOperationsWithArtifacts({
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
  readonly backupResources: () =>
    | Promise<Readonly<{ db: DbClient; secretBox: SecretBox | undefined }>>
    | Readonly<{ db: DbClient; secretBox: SecretBox | undefined }>
  readonly appHome: string
  readonly dbPath: string
  readonly lockPath: string
  readonly resolveRestoreMigrations: () => Promise<string>
}): SystemOperationsModule {
  const adapter = createLegacyPlatformRecoveryAdapter(deps)
  return Object.freeze({
    application: createSystemOperationsApplication(adapter),
    artifacts: deps.artifacts,
  })
}
