// RFC-370 v3 V5 — restore a hosted backup into the EMPTY database the platform
// provisioned for CS RFC-042 (or resume exactly this restore). Runs only in the
// release migration Job (`agent-workflow migrate` with
// CS_DATABASE_RESTORE_REFERENCE); serving instances never call it, and no
// DROP/TRUNCATE or replacement of another live database is possible.
//
//   1. download + verify the archive, replay it with the standalone PostgreSQL
//      logical import (copy operation `dbm_hosted_restore_<digest>`);
//   2. activate the platform's generation, marked `hosted-backup:<id>`;
//   3. run every owner's restore-normalization participant (no cross-context SQL);
//   4. finalize: record the per-table digests the verify Job checks and clear
//      the live-write marker that the normalization writes themselves set.
import type { ProviderNeutralDatabase } from '@/db/query'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import type {
  PostgresqlDatabaseRuntime,
  PostgresqlReservedConnection,
} from '@/platform/persistence/postgresqlRuntime'
import {
  POSTGRESQL_METADATA_SCHEMA,
  type PostgresqlSchemaPlan,
} from '@/platform/persistence/postgresqlSchema'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import { createLogger } from '@/util/log'
import type { HostedRestoreNormalizationParticipant } from './restoreNormalizationContract'
import {
  openHostedDatabaseBackupArchive,
  type HostedRestoreArtifact,
} from './databaseRestoreArtifact'
import { recordRestoredDatabaseDigests } from './databaseRestoreVerification'
import { createHostedSystemRestoreNormalization } from './hostedRestoreNormalization'

const SCHEMA_LOCK = 'rfc359-schema-upgrade'
const metadata = (table: string) => `"${POSTGRESQL_METADATA_SCHEMA}"."${table}"`

type TargetState = 'empty' | 'copying' | 'verified' | 'activated' | 'finalized'

async function inspectTarget(
  connection: PostgresqlReservedConnection,
  artifact: HostedRestoreArtifact,
  generation: { readonly generationId: string; readonly operationId: string },
  contract: LogicalSchemaContract,
): Promise<TargetState> {
  const tables = await connection.unsafe(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2',
    [POSTGRESQL_METADATA_SCHEMA, 'BASE TABLE'],
  )
  const names = new Set(tables.map((row) => String(row.table_name)))
  let copyStage: string | undefined
  if (names.has('logical_copy_operations')) {
    const copy = await connection.unsafe(
      `SELECT stage, source_generation_id FROM ${metadata('logical_copy_operations')} WHERE operation_id = $1`,
      [artifact.copyOperationId],
    )
    if (copy.length === 1 && copy[0]!.source_generation_id !== artifact.marker)
      throw new Error('hosted-restore-target-not-empty')
    copyStage = copy[0]?.stage === undefined ? undefined : String(copy[0].stage)
  }
  if (names.has('database_generations')) {
    const active = await connection.unsafe(
      `SELECT generation_id, operation_id, source_generation_id, contract_digest FROM ${metadata('database_generations')} WHERE state = 'active'`,
    )
    if (active.length > 1) throw new Error('hosted-restore-target-not-empty')
    if (active.length === 1) {
      const row = active[0]!
      // Only this exact restore may own the target's active generation.
      if (
        row.generation_id !== generation.generationId ||
        row.operation_id !== generation.operationId ||
        row.source_generation_id !== artifact.marker ||
        row.contract_digest !== contract.digest
      )
        throw new Error('hosted-restore-target-not-empty')
      return copyStage === 'finalized' ? 'finalized' : 'activated'
    }
  }
  if (copyStage === 'verified' || copyStage === 'finalized') return 'verified'
  return copyStage === undefined ? 'empty' : 'copying'
}

export async function restoreHostedDatabaseInstallation(input: {
  readonly runtime: PostgresqlDatabaseRuntime
  readonly reference: string
  readonly installation: string
  readonly objectSpaceId: string
  readonly keyFingerprint: string
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
  readonly generation: { readonly generationId: string; readonly operationId: string }
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  /** Owner participants composed by bootstrap; System Operations adds its own. */
  readonly normalization: readonly HostedRestoreNormalizationParticipant[]
  readonly now?: () => number
  readonly openArtifact?: typeof openHostedDatabaseBackupArchive
  readonly openTarget?: typeof openPostgresqlLogicalTarget
  readonly openClient?: (runtime: PostgresqlDatabaseRuntime) => ProviderNeutralDatabase
}): Promise<{ restored: boolean; backupId: string; normalized: Readonly<Record<string, number>> }> {
  const now = input.now ?? Date.now
  const log = createLogger('hosted-database-restore')
  const artifact = await (input.openArtifact ?? openHostedDatabaseBackupArchive)(input)
  const connection = await input.runtime
    .providerPool()
    .reserve()
    .catch((error: unknown) => {
      artifact.close()
      throw error
    })
  let locked = false,
    transaction = false
  try {
    const acquired = await connection.unsafe(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [SCHEMA_LOCK],
    )
    if (acquired[0]?.acquired !== true) throw new Error('hosted-restore-schema-lock-held')
    locked = true
    const state = await inspectTarget(connection, artifact, input.generation, input.contract)
    if (state === 'finalized')
      return { restored: false, backupId: artifact.sidecar.backupId, normalized: {} }
    if (state === 'empty' || state === 'copying' || state === 'verified') {
      const target = await (input.openTarget ?? openPostgresqlLogicalTarget)({
        runtime: input.runtime,
        operationId: artifact.copyOperationId,
        sourceGenerationId: artifact.marker,
        contract: input.contract,
        plan: input.plan,
      })
      try {
        if (state === 'verified') {
          // A resumed restore re-checks the already verified copy only.
          await target.prepare(now())
          await target.finalizeSchema(now(), artifact.tables)
        } else await artifact.replay(target)
      } finally {
        await target.close()
      }
      await connection.unsafe('BEGIN')
      transaction = true
      const verified = await connection.unsafe(
        `SELECT stage FROM ${metadata('logical_copy_operations')} WHERE operation_id = $1 FOR UPDATE`,
        [artifact.copyOperationId],
      )
      if (verified.length !== 1 || verified[0]?.stage !== 'verified')
        throw new Error('hosted-restore-target-not-verified')
      // The platform's generation becomes active so owner participants write
      // through the ordinary fenced business client. No instance serves this
      // database before the CS switch, which follows a passing verify Job.
      await connection.unsafe(
        `INSERT INTO ${metadata('logical_copy_operations')} (operation_id, source_generation_id, contract_digest, plan_digest, stage, created_at, updated_at) VALUES ($1, $2, $3, $4, 'activated', $5, $5) ON CONFLICT (operation_id) DO NOTHING`,
        [
          input.generation.operationId,
          artifact.marker,
          input.contract.digest,
          input.plan.digest,
          now(),
        ],
      )
      await connection.unsafe(
        `INSERT INTO ${metadata('database_generations')} (generation_id, operation_id, source_generation_id, contract_digest, state, activated_at, first_live_write_at) VALUES ($1, $2, $3, $4, 'active', $5, NULL) ON CONFLICT (generation_id) DO NOTHING`,
        [
          input.generation.generationId,
          input.generation.operationId,
          artifact.marker,
          input.contract.digest,
          now(),
        ],
      )
      await connection.unsafe('COMMIT')
      transaction = false
    }
    const client = (input.openClient ?? createPostgresqlDatabaseClient)(input.runtime)
    const session = databaseSessionFor(client)
    const normalized: Record<string, number> = {}
    for (const participant of [
      createHostedSystemRestoreNormalization({
        sidecar: artifact.sidecar,
        object: artifact.object,
      }),
      ...input.normalization,
    ]) {
      const counters = await session.transaction((tx) =>
        participant.normalize(tx, { restoreOperationId: input.generation.operationId, now: now() }),
      )
      for (const [key, value] of Object.entries(counters))
        normalized[`${participant.name}.${key}`] = value
    }
    await connection.unsafe('BEGIN')
    transaction = true
    const copy = await connection.unsafe(
      `SELECT stage FROM ${metadata('logical_copy_operations')} WHERE operation_id = $1 FOR UPDATE`,
      [artifact.copyOperationId],
    )
    if (copy.length !== 1 || !['verified', 'finalized'].includes(String(copy[0]?.stage)))
      throw new Error('hosted-restore-target-not-verified')
    await connection.unsafe(
      `UPDATE ${metadata('logical_copy_operations')} SET stage = 'finalized', updated_at = $2 WHERE operation_id = $1`,
      [artifact.copyOperationId, now()],
    )
    await connection.unsafe(
      `DELETE FROM ${metadata('logical_copy_chunks')} WHERE operation_id = $1`,
      [input.generation.operationId],
    )
    await recordRestoredDatabaseDigests(
      connection,
      input.contract,
      input.generation.operationId,
      now(),
    )
    // Normalization is part of producing the restored image, not live traffic:
    // the verify Job requires that nothing wrote after this point.
    await connection.unsafe(
      `UPDATE ${metadata('database_generations')} SET first_live_write_at = NULL WHERE generation_id = $1 AND operation_id = $2 AND state = 'active'`,
      [input.generation.generationId, input.generation.operationId],
    )
    await connection.unsafe('COMMIT')
    transaction = false
    log.info('hosted database restored', { backupId: artifact.sidecar.backupId, normalized })
    return { restored: true, backupId: artifact.sidecar.backupId, normalized }
  } catch (error) {
    if (transaction) await Promise.resolve(connection.unsafe('ROLLBACK')).catch(() => undefined)
    throw error
  } finally {
    try {
      if (locked)
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [SCHEMA_LOCK])
    } finally {
      connection.release()
      artifact.close()
    }
  }
}
