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
  ActivateLocalRestoreOptions,
  BackupResultView,
  LocalRestoreActivationResult,
  LocalSystemOperationContext,
  RequestBackupInput,
  RestorePlanOptions,
  RestorePlanView,
  StageRestoreOptions,
  StageRestoreResult,
} from './public/types'

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

export interface LocalRestoreSession {
  plan(options: RestorePlanOptions): Promise<RestorePlanView>
  stage(options: StageRestoreOptions): Promise<StageRestoreResult>
  activate(options: ActivateLocalRestoreOptions): Promise<LocalRestoreActivationResult>
  release(): void
}

export interface LocalSystemOperations {
  requestBackup(input: RequestBackupInput): Promise<BackupResultView>
  prepareRestore(path: string): Promise<LocalRestoreSession>
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
    requestBackup(input) {
      return module.application.commands.requestBackup.execute(context, input)
    },
    async prepareRestore(path) {
      await resolveRestoreMigrations()
      const artifactRef = artifacts.ingestLocalPath(path)
      let released = false
      const session: LocalRestoreSession = {
        plan(options) {
          return module.application.queries.planLocalRestore.execute(context, {
            artifactRef,
            ...options,
          })
        },
        stage(options) {
          return module.application.commands.stageRestore.execute(context, {
            artifactRef,
            ...options,
          })
        },
        activate(options) {
          return module.application.commands.activateLocalRestore.execute(context, {
            artifactRef,
            ...options,
          })
        },
        release() {
          if (released) return
          released = true
          artifacts.release(artifactRef)
        },
      }
      return Object.freeze(session)
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
