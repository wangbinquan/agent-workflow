import { withNativeTransaction } from '@/platform/persistence/nativeTransaction'
import { postgresqlHistoryConnection } from '@/platform/persistence/schema/history/connection'
import { schemaHistoryRuntime } from '@/platform/persistence/schema/history/runtime'
import {
  readRestoreReceipt,
  writeRestoreReceipt,
  type HostedEpoch2RestoreReceipt,
} from './epoch2RestoreReceipt'
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
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { CrewStationStreamObjectStorage } from '@/platform/crewstation/objectStorage'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { createPostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { type PostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import type { LogicalSchemaContract } from '@/platform/persistence/schemaContract'
import type { HostedRestoreNormalizationParticipant } from './restoreNormalizationContract'
import { openHostedDatabaseBackupArchive } from './databaseRestoreArtifact'
import {
  recordRestoredDatabaseDigests,
  verifyHostedDatabaseRestore,
} from './databaseRestoreVerification'
import { createHostedSystemRestoreNormalization } from './hostedRestoreNormalization'

const SCHEMA_LOCK = 'rfc359-schema-upgrade'

export async function restoreHostedDatabaseInstallation(input: {
  readonly headContract: LogicalSchemaContract
  readonly runtime: PostgresqlDatabaseRuntime
  readonly reference: string
  readonly installation: string
  readonly objectSpaceId: string
  readonly keyFingerprint: string
  readonly contract: LogicalSchemaContract
  readonly plan: PostgresqlSchemaPlan
  readonly generation: { readonly generationId: string; readonly operationId: string }
  readonly objects: Pick<CrewStationStreamObjectStorage, 'open'>
  readonly normalization: readonly HostedRestoreNormalizationParticipant[]
  readonly now?: () => number
  readonly openArtifact?: typeof openHostedDatabaseBackupArchive
  readonly openTarget?: typeof openPostgresqlLogicalTarget
  readonly openClient?: (runtime: PostgresqlDatabaseRuntime) => PersistenceDb
}): Promise<{ restored: boolean; backupId: string; normalized: Readonly<Record<string, number>> }> {
  const now = input.now ?? Date.now
  const artifact = await (input.openArtifact ?? openHostedDatabaseBackupArchive)(input)
  const connection = await input.runtime
    .providerPool()
    .reserve()
    .catch((error) => {
      artifact.close()
      throw error
    })
  let locked = false
  try {
    const acquired = await connection.unsafe(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [SCHEMA_LOCK],
    )
    if (acquired[0]?.acquired !== true) throw new Error('hosted-restore-schema-lock-held')
    locked = true
    const metadata = await connection.unsafe(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='agent_workflow_meta' AND table_type='BASE TABLE'",
    )
    const names = new Set(metadata.map((row) => String(row.table_name)))
    const state = names.has('migration_records')
      ? await readRestoreReceipt<{
          stage: string
          sourceGenerationId: string
          installedSourceGenerationId?: string
          contractDigest: string
          planDigest: string
        }>(connection, artifact.copyOperationId, 'epoch2-copy')
      : null
    const binding = names.has('migration_records')
      ? await readRestoreReceipt<{ generationId: string; operationId: string }>(
          connection,
          artifact.copyOperationId,
          'hosted-restore-binding',
        )
      : null
    if (
      binding &&
      (binding.generationId !== input.generation.generationId ||
        binding.operationId !== input.generation.operationId)
    )
      throw new Error('hosted-restore-target-not-empty')
    if (
      state &&
      (state.sourceGenerationId !== artifact.marker ||
        state.contractDigest !== input.contract.digest ||
        state.planDigest !== input.plan.digest)
    )
      throw new Error('hosted-restore-target-not-empty')
    // P-1: refuse a serving installation before opening a target or replaying
    // any rows. Epoch 2 records copy ownership separately from the platform's
    // final restore receipt and preserves the installed source as lineage.
    if (names.has('generations')) {
      const active = await connection.unsafe(
        "SELECT generation_id, operation_id, source_generation_id, contract_digest, plan_digest FROM agent_workflow_meta.generations WHERE state='active'",
      )
      const head = schemaHistoryRuntime().head()
      if (
        active.length > 1 ||
        (active.length === 1 &&
          (!state ||
            !binding ||
            active[0]!.generation_id !== input.generation.generationId ||
            active[0]!.operation_id !== artifact.copyOperationId ||
            active[0]!.source_generation_id !==
              (state.installedSourceGenerationId ?? artifact.marker) ||
            active[0]!.contract_digest !== head.contract.contract.digest ||
            active[0]!.plan_digest !== input.plan.digest))
      )
        throw new Error('hosted-restore-target-not-empty')
    }
    if (names.has('migration_records')) {
      const receipt = await readRestoreReceipt<HostedEpoch2RestoreReceipt>(
        connection,
        input.generation.operationId,
        'hosted-restore',
      )
      if (receipt) {
        if (
          receipt.generationId !== input.generation.generationId ||
          receipt.copyOperationId !== artifact.copyOperationId ||
          receipt.logicalDigest !== input.contract.digest ||
          receipt.backupId !== artifact.sidecar.backupId
        )
          throw new Error('hosted-restore-target-not-empty')
        await verifyHostedDatabaseRestore(input)
        return { restored: false, backupId: receipt.backupId, normalized: {} }
      }
    }
    const openTarget = () =>
      (input.openTarget ?? openPostgresqlLogicalTarget)({
        headContract: input.headContract,
        runtime: input.runtime,
        operationId: artifact.copyOperationId,
        sourceGenerationId: artifact.marker,
        contract: input.contract,
        plan: input.plan,
      })
    const target = await openTarget()
    try {
      if (state?.stage !== 'activated' && state?.stage !== 'finalized') {
        if (state?.stage === 'verified') {
          await target.prepare(now())
          await target.finalizeSchema(now(), artifact.tables)
        } else await artifact.replay(target)
        // Bind the platform operation before activation, so an interrupted
        // normalization can only be resumed by this exact restore Job.
        await writeRestoreReceipt(
          connection,
          artifact.copyOperationId,
          'hosted-restore-binding',
          input.generation,
        )
        await target.prepareGeneration({
          generationId: input.generation.generationId,
          sourceGenerationId: artifact.marker,
        })
        await target.activateGeneration(input.generation.generationId, now())
      }
      await target.assertReady(input.generation.generationId)
    } finally {
      // The schema lock owns one of the two hosted pool slots. Release the copy
      // connection before owner normalization opens its business transaction.
      await target.close()
    }
    const client = (input.openClient ?? createPostgresqlDatabaseClient)(input.runtime)
    const session = databaseSessionFor(client),
      normalized: Record<string, number> = {}
    for (const participant of [
      createHostedSystemRestoreNormalization({
        sidecar: artifact.sidecar,
        object: artifact.object,
      }),
      ...input.normalization,
    ]) {
      const counters = await session.transaction((tx) =>
        participant.normalize(tx, {
          restoreOperationId: input.generation.operationId,
          now: now(),
        }),
      )
      for (const [key, value] of Object.entries(counters))
        normalized[`${participant.name}.${key}`] = value
    }
    // Normalization is part of the offline image. The final receipt, digests
    // and cleared marker commit together, before the platform may activate it.
    await withNativeTransaction(postgresqlHistoryConnection(connection), async () => {
      const transaction = connection
      const final = { unsafe: transaction.unsafe.bind(transaction) }
      await transaction.unsafe(
        "SELECT generation_id FROM agent_workflow_meta.generations WHERE generation_id=$1 AND state='active' FOR UPDATE",
        [input.generation.generationId],
      )
      await recordRestoredDatabaseDigests(
        final,
        input.contract,
        input.generation.operationId,
        now(),
      )
      await writeRestoreReceipt(final, input.generation.operationId, 'hosted-restore', {
        stage: 'finalized',
        generationId: input.generation.generationId,
        copyOperationId: artifact.copyOperationId,
        backupId: artifact.sidecar.backupId,
        logicalDigest: input.contract.digest,
        completedAt: now(),
      } satisfies HostedEpoch2RestoreReceipt)
      await transaction.unsafe(
        'UPDATE agent_workflow_meta.first_write SET first_live_write_at=NULL WHERE generation_id=$1',
        [input.generation.generationId],
      )
    })
    const finalizedTarget = await openTarget()
    try {
      await finalizedTarget.markFinalized(now())
    } finally {
      await finalizedTarget.close()
    }
    return { restored: true, backupId: artifact.sidecar.backupId, normalized }
  } finally {
    try {
      if (locked)
        await connection.unsafe('SELECT pg_advisory_unlock(hashtextextended($1,0))', [SCHEMA_LOCK])
    } finally {
      connection.release()
      artifact.close()
    }
  }
}
