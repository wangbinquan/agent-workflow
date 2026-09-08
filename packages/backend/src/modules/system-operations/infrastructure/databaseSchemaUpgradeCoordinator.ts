// RFC-359 T19h — complete schema preparation before a provider enters the
// application graph. Historical copies finish with their original contracts;
// schema DDL and the generation pointer never stand in for copied business rows.

import type { DatabaseConfig } from '@agent-workflow/shared'
import type { OpenDbOptions } from '@/db/client'
import {
  prepareDatabaseProviderRuntime,
  type ResolveDatabaseProviderRuntimeOptions,
} from '@/platform/persistence/databaseProviderRuntime'
import {
  digestGenerationPayload,
  writeDatabaseGenerationAtomic,
  type DatabaseGenerationBootstrapCandidate,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationStore'
import { loadPostgresqlMigrationHistory } from '@/platform/persistence/postgresqlMigrationHistory'
import {
  resolvePostgresqlIndexOnlyRowBridge,
  type PostgresqlMigrationHistory,
} from '@/platform/persistence/postgresqlMigrationSequence'
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import { acquireLock, type Lock } from '@/util/lock'
import { createDatabaseMigrationControlPlane } from '../application/databaseMigrationControlPlane'
import { DatabaseMigrationRunnerError } from '../application/databaseMigrationRunner'
import {
  createDatabaseMigrationCoordinator,
  readDatabaseSchemaUpgradeGeneration,
} from './databaseMigrationCoordinator'
import { createFileDatabaseMigrationStore } from './fileDatabaseMigrationStore'

export interface DatabaseSchemaUpgradeOptions extends ResolveDatabaseProviderRuntimeOptions {
  readonly sqliteOptions: Omit<OpenDbOptions, 'path'>
  readonly beforeSqliteOpen?: () => void | Promise<void>
  readonly lockPath: string
  /** Daemon start already owns this lock before pending restore. */
  readonly lock?: Lock
  readonly readConfig: () => DatabaseConfig
  readonly writeConfig: (config: DatabaseConfig) => void | Promise<void>
  readonly history?: PostgresqlMigrationHistory
  /** File-commit fault seams; production keeps the durable writer defaults. */
  readonly beforePointerReplaceForTest?: () => void
  readonly afterPointerReplaceForTest?: () => void
}

function candidatePayload(
  candidate: DatabaseGenerationBootstrapCandidate,
): DatabaseGenerationPayload {
  return candidate.kind === 'current' ? candidate.generation.payload : candidate.payload
}

export async function prepareDatabaseSchemaUpgrade(
  options: DatabaseSchemaUpgradeOptions,
): ReturnType<typeof prepareDatabaseProviderRuntime> {
  const history = options.history ?? (await loadPostgresqlMigrationHistory())
  const readCandidate = () => readDatabaseSchemaUpgradeGeneration({ ...options, history })
  let candidate = readCandidate()
  let config = options.config
  const controlPlane = createDatabaseMigrationControlPlane({
    store: createFileDatabaseMigrationStore({ root: options.operationsRoot }),
  })
  const initialGeneration = candidatePayload(candidate)
  const interrupted = controlPlane
    .list()
    .filter((status) => status.phase !== 'finalized' && status.rolledBackAt === null)
    .filter(
      (status) =>
        status.sourceGenerationId === initialGeneration.generationId ||
        status.operationId === initialGeneration.operationId,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
  const pending =
    databaseProviderTraits(initialGeneration.provider).migrationRole === 'target' &&
    initialGeneration.operationId !== null
      ? controlPlane.readManifest(initialGeneration.operationId)
      : interrupted === undefined
        ? null
        : controlPlane.readManifest(interrupted.operationId)
  const historicalCopy =
    pending !== null && pending.payload.source.schemaDigest !== options.contract.digest
  const boundTargetOperation =
    pending !== null &&
    databaseProviderTraits(initialGeneration.provider).migrationRole === 'target' &&
    initialGeneration.operationId === pending.payload.operationId
  const needsCopyRecovery =
    pending !== null &&
    pending.payload.phase !== 'accepting-writes' &&
    pending.payload.phase !== 'finalized' &&
    (historicalCopy || boundTargetOperation || candidate.kind === 'operation-recovery')
  let heldLock: Lock | undefined
  const requireUpgradeLock = () => {
    if (options.lock === undefined && heldLock === undefined)
      heldLock = acquireLock(options.lockPath)
  }

  const advancePointer = (original: DatabaseGenerationBootstrapCandidate) => {
    if (original.kind === 'current') return
    const current = readCandidate()
    const payload = candidatePayload(current)
    const next = {
      ...original.payload,
      schemaDigest: options.contract.digest,
      ...(original.kind === 'operation-recovery'
        ? { manifestDigest: original.recoveryManifestDigest }
        : {}),
    }
    if (digestGenerationPayload(payload) === digestGenerationPayload(next)) return
    if (
      current.kind === 'current' ||
      current.pointerDigest !== original.pointerDigest ||
      (original.kind === 'operation-recovery' &&
        (current.kind !== 'operation-recovery' ||
          current.recoveryManifestDigest !== original.recoveryManifestDigest))
    ) {
      throw new Error('database generation changed during schema preparation')
    }
    writeDatabaseGenerationAtomic({
      pointerPath: options.generationPointerPath,
      payload: next,
      beforeReplaceForTest: options.beforePointerReplaceForTest,
      afterReplaceForTest: options.afterPointerReplaceForTest,
    })
  }

  try {
    if (candidate.kind !== 'current' || needsCopyRecovery) requireUpgradeLock()
    if (
      (historicalCopy || boundTargetOperation || candidate.kind === 'operation-recovery') &&
      pending !== null
    ) {
      const bridge = resolvePostgresqlIndexOnlyRowBridge(history, {
        fromContractDigest: pending.payload.source.schemaDigest,
        toContractDigest: options.contract.digest,
      })
      if (
        pending.payload.failure !== null ||
        pending.payload.cancelledAt !== null ||
        pending.payload.cancellationRequestedAt !== null
      ) {
        throw new DatabaseMigrationRunnerError(
          'database-migration-resume-required',
          'migration is failed or cancelled and requires an explicit resume before schema upgrade',
        )
      }
      if (needsCopyRecovery) {
        if (boundTargetOperation) {
          candidate = readDatabaseSchemaUpgradeGeneration({
            ...options,
            history,
            pendingOperationId: pending.payload.operationId,
          })
        }
        const recovery = createDatabaseMigrationCoordinator({
          sqlitePath: options.sqlitePath,
          operationsRoot: options.operationsRoot,
          generationPointerPath: options.generationPointerPath,
          contract: bridge.source,
          interruptedOperationId: pending.payload.operationId,
          env: options.env,
          // The held daemon lock is the real offline freeze/drain boundary.
          admission: {
            async freezeAndDrain() {},
            async reopenSqlite() {},
            async activatePostgresql() {},
            async openPostgresqlAdmission() {},
          },
          activateTargetConfig: (target) => options.writeConfig(target),
          activateSourceConfig: () => options.writeConfig({ provider: 'sqlite' }),
        })
        const settled = await recovery.resumeInterrupted(pending.payload.target)
        if (settled === null || settled.phase !== 'accepting-writes' || settled.failure !== null) {
          throw new DatabaseMigrationRunnerError(
            'database-migration-resume-required',
            'migration requires an explicit resume before schema upgrade',
          )
        }
        config = options.readConfig()
        candidate = readCandidate()
      }
    }

    return await prepareDatabaseProviderRuntime({
      ...options,
      config,
      candidate,
      history,
      requireUpgradeLock,
      advancePointer: () => advancePointer(candidate),
    })
  } finally {
    heldLock?.release()
  }
}
