// RFC-398 §4: v0.19.2 status/finalize protocol, restricted to epoch-1 installations.
import { join } from 'node:path'
import { createDatabaseMigrationControlPlane } from '../../application/databaseMigrationControlPlane'
import type { LegacyMigrationFinalizePort } from '../../application/ports/epochSwitch'
import type { DatabaseMigrationManifest } from '../../domain/databaseMigration'
import { createFileDatabaseMigrationStore } from '../fileDatabaseMigrationStore'
import { createFileDatabaseMigrationArtifactStore } from '../fileDatabaseMigrationArtifactStore'
import { writeDatabaseGenerationAtomic } from '@/platform/persistence/generationStore'
import { readMigrationSourcePointer } from '@/platform/persistence/migration/generationPointerSource'
import { resolveEpoch1PostgresqlVersion } from '@/platform/persistence/migration/epoch1/releasedPostgresql'
import { loadFrozenEpoch1History } from '@/platform/persistence/migration/epoch1/bundle'
import { resolvePostgresqlAdditiveRowBridge } from '@/platform/persistence/migration/legacy/postgresqlMigrationSequence'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/migration/legacy/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { canonicalSchemaJson } from '@/platform/persistence/schema/canonical'

export type LegacyFinalizeStep =
  | 'first-write-manifest'
  | 'status-pointer'
  | 'final-receipt'
  | 'target-finalized'
  | 'finalized-manifest'
  | 'finalized-pointer'
export class LegacyMigrationFinalizeError extends Error {
  constructor(
    readonly code: string,
    operationId: string,
  ) {
    super(
      `${code}: use the old binary's db migration status|resume|cancel ${operationId} to finish or cancel this operation.`,
    )
    this.name = 'LegacyMigrationFinalizeError'
  }
}

export function createLegacyMigrationFinalize(input: {
  readonly appHome: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly now?: () => number
  readonly afterPersist?: (step: LegacyFinalizeStep) => void
}): LegacyMigrationFinalizePort {
  const operationsRoot = join(input.appHome, 'database-migrations')
  const pointerPath = join(input.appHome, 'database-generation.json')
  const control = createDatabaseMigrationControlPlane({
    store: createFileDatabaseMigrationStore({ root: operationsRoot }),
  })
  const artifacts = createFileDatabaseMigrationArtifactStore({ operationsRoot })
  const checkpoint = (manifest: DatabaseMigrationManifest, phase: string): number => {
    const value = manifest.payload.checkpoints.find((entry) => entry.phase === phase)
    if (!value) throw new Error(`database-migration-manifest-corrupt: missing ${phase} checkpoint`)
    return value.committedAt
  }
  const perform = async (operationId: string, finalize: boolean) => {
    let manifest = control.readManifest(operationId)
    const pointer = readMigrationSourcePointer(pointerPath).pointer
    if (pointer?.payload.version === 2) throw new Error('rfc349-epoch1-adapter-on-epoch2')
    const version = await resolveEpoch1PostgresqlVersion(manifest.payload.source.schemaDigest)
    if (!version) throw new Error('rfc349-source-contract-unsupported')
    if (manifest.payload.rolledBackAt !== null) {
      if (finalize)
        throw new LegacyMigrationFinalizeError('rfc349-operation-unfinished', operationId)
      return control.get(operationId)
    }
    if (
      !['switched', 'health-checked', 'accepting-writes', 'finalized'].includes(
        manifest.payload.phase,
      )
    ) {
      if (finalize)
        throw new LegacyMigrationFinalizeError('rfc349-operation-unfinished', operationId)
      return control.get(operationId)
    }
    const generationId = `dbg_pg_${operationId.slice(4)}`
    const runtime = createPostgresqlDatabaseRuntime({
      config: { ...manifest.payload.target, provider: 'postgresql' },
      generationId,
      env: input.env,
    })
    let target: Awaited<ReturnType<typeof openPostgresqlLogicalTarget>> | undefined
    try {
      const health = await runtime.readiness()
      if (manifest.payload.target.databaseFingerprint !== health.databaseFingerprint)
        throw new Error('rfc349-target-fingerprint-mismatch')
      const live = (
        await runtime
          .providerPool()
          .unsafe(
            'SELECT contract_digest FROM agent_workflow_meta.schema_contract WHERE singleton=TRUE',
          )
      )[0]?.contract_digest
      const liveVersion =
        typeof live === 'string' ? await resolveEpoch1PostgresqlVersion(live) : null
      if (!liveVersion || typeof live !== 'string')
        throw new Error('rfc349-live-contract-unsupported')
      if (live !== version.contract.digest)
        resolvePostgresqlAdditiveRowBridge((await loadFrozenEpoch1History()).postgresql, {
          fromContractDigest: version.contract.digest,
          toContractDigest: live,
        })
      target = await openPostgresqlLogicalTarget({
        runtime,
        operationId,
        sourceGenerationId: manifest.payload.source.generationId,
        headContract: liveVersion.contract,
        contract: version.contract,
        plan: version.plan,
        async verifyMigrationHistory(plan) {
          if (canonicalSchemaJson(plan) !== canonicalSchemaJson(version.plan))
            throw new Error('rfc349-original-plan-mismatch')
        },
      })
      const refreshPointer = (step: 'status-pointer' | 'finalized-pointer') => {
        manifest = control.readManifest(operationId)
        writeDatabaseGenerationAtomic({
          pointerPath,
          payload: {
            version: 1,
            generationId,
            provider: 'postgresql',
            operationId,
            schemaDigest: live,
            manifestDigest: artifacts.manifestFileDigest(operationId),
            activatedAt: checkpoint(manifest, 'switched'),
          },
        })
        input.afterPersist?.(step)
      }
      // v0.19.2 :711–729: status refreshes the first write before any final receipt.
      if (manifest.payload.phase !== 'finalized' && manifest.payload.firstLiveWriteAt === null) {
        const first = await target.firstLiveWriteAt(generationId)
        if (first !== null) {
          control.markFirstLiveWrite(operationId, first)
          input.afterPersist?.('first-write-manifest')
          refreshPointer('status-pointer')
          manifest = control.readManifest(operationId)
        }
      }
      if (!finalize) return control.get(operationId)
      // v0.19.2 :777–817: the accepting-writes checkpoint makes file replay byte-identical.
      if (manifest.payload.phase !== 'accepting-writes' && manifest.payload.phase !== 'finalized')
        throw new LegacyMigrationFinalizeError('rfc349-operation-unfinished', operationId)
      const finalizedAt = checkpoint(manifest, 'accepting-writes')
      if (manifest.payload.phase === 'finalized') {
        await target.markFinalized(finalizedAt)
        input.afterPersist?.('target-finalized')
        refreshPointer('finalized-pointer')
        return control.get(operationId)
      }
      const receiptDigest = artifacts.writeFinalReceipt(operationId, {
        version: 1,
        operationId,
        sourceGenerationId: manifest.payload.source.generationId,
        targetGenerationId: generationId,
        schemaDigest: manifest.payload.source.schemaDigest,
        logicalBackupDigest: manifest.payload.logicalBackupDigest,
        legacyArchiveDigest: manifest.payload.legacyArchiveDigest,
        verificationDigest: manifest.payload.verificationDigest,
        firstLiveWriteAt: manifest.payload.firstLiveWriteAt,
        finalizedAt,
      })
      input.afterPersist?.('final-receipt')
      // Frozen adapter updates agent_workflow_meta.logical_copy_operations, never epoch-2 meta.
      await target.markFinalized(finalizedAt)
      input.afterPersist?.('target-finalized')
      const status = control.advance(operationId, {
        expectedPhase: 'accepting-writes',
        nextPhase: 'finalized',
        ownerId: manifest.payload.owner.id,
        ownerFence: manifest.payload.owner.fence,
        idempotencyKey: `${operationId}:finalized:v1`,
        now: (input.now ?? Date.now)(),
        receiptDigest,
      })
      input.afterPersist?.('finalized-manifest')
      refreshPointer('finalized-pointer')
      return status
    } finally {
      await target?.close()
      await runtime.close()
    }
  }
  return {
    status: (operationId) => perform(operationId, false),
    finalize: (operationId) => perform(operationId, true),
  }
}
