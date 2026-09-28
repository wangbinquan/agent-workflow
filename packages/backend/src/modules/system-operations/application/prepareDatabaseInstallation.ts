// RFC-370 A-T2: shared installation decisions, independent of file paths,
// host locks and concrete provider/copy mechanisms.
import type { DatabaseConfig } from '@agent-workflow/shared'
import type { DatabaseConfigurationPort } from './ports/databaseConfiguration'
import type { DatabaseInstallationPort } from './ports/databaseInstallation'
import {
  digestGenerationPayload,
  type DatabaseGenerationBootstrapCandidate,
  type DatabaseGenerationPayload,
} from '@/platform/persistence/generationValidation'
import {
  resolvePostgresqlAdditiveRowBridge,
  type PostgresqlMigrationHistory,
} from '@/platform/persistence/postgresqlMigrationSequence'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { databaseProviderTraits } from '@/platform/persistence/providerTraits'
import { DatabaseMigrationRunnerError } from './databaseMigrationRunner'

function candidatePayload(
  candidate: DatabaseGenerationBootstrapCandidate,
): DatabaseGenerationPayload {
  return candidate.kind === 'current' ? candidate.generation.payload : candidate.payload
}

export async function prepareDatabaseInstallation<TPrepared>(options: {
  readonly config: DatabaseConfig
  readonly contract: LogicalSchemaContract
  readonly history: PostgresqlMigrationHistory
  readonly configuration: DatabaseConfigurationPort
  readonly effects: DatabaseInstallationPort<TPrepared>
}): Promise<TPrepared> {
  const { history, effects } = options
  const readCandidate = () => effects.readGeneration({ contract: options.contract, history })
  let candidate = await readCandidate()
  let config = options.config
  const initialGeneration = candidatePayload(candidate)
  const interrupted = (await effects.listMigrations())
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
      ? await effects.readMigration(initialGeneration.operationId)
      : interrupted === undefined
        ? null
        : await effects.readMigration(interrupted.operationId)
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
  const requireUpgradeLock = async () => {
    await effects.requireUpgradeLock()
  }

  const advancePointer = async (original: DatabaseGenerationBootstrapCandidate) => {
    if (original.kind === 'current') return
    const current = await readCandidate()
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
    await effects.writeGeneration(next)
  }

  try {
    if (candidate.kind !== 'current' || needsCopyRecovery) await requireUpgradeLock()
    if (
      (historicalCopy || boundTargetOperation || candidate.kind === 'operation-recovery') &&
      pending !== null
    ) {
      const bridge = resolvePostgresqlAdditiveRowBridge(history, {
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
          candidate = await effects.readGeneration({
            contract: options.contract,
            history,
            pendingOperationId: pending.payload.operationId,
          })
        }
        const settled = await effects.resumeMigration({
          contract: bridge.source,
          operationId: pending.payload.operationId,
          target: pending.payload.target,
        })
        if (settled === null || settled.phase !== 'accepting-writes' || settled.failure !== null) {
          throw new DatabaseMigrationRunnerError(
            'database-migration-resume-required',
            'migration requires an explicit resume before schema upgrade',
          )
        }
        config = await options.configuration.read()
        candidate = await readCandidate()
      }
    }

    return await effects.prepareProvider({
      contract: options.contract,
      config,
      candidate,
      history,
      requireUpgradeLock,
      advancePointer: () => advancePointer(candidate),
    })
  } finally {
    await effects.releaseUpgradeLock()
  }
}
