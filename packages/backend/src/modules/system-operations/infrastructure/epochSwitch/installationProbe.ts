import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseProvider } from '@/platform/persistence/databaseProviders'
import { metaTableName } from '@/platform/persistence/schema/history/meta'
import { parameters } from '@/platform/persistence/schema/history/connection'
import type { ConversionTargetConnection } from '@/platform/persistence/migration/run/types'
import type { EpochSourceLocation } from '@/platform/persistence/migration/run/types'
import { readMigrationSourcePointer } from '@/platform/persistence/migration/generationPointerSource'
import type { EpochSwitchJournalPort } from '../../application/ports/epochSwitch'
import type { EpochInstallationProbe } from '../../application/epochSwitch/session'
import { parseActivationReceipt } from '../../domain/epochSwitch/documents'
import { verifyDatabaseMigrationManifest } from '../../domain/databaseMigration'

export function createEpochInstallationProbe(input: {
  pointerPath: string
  migrationsRoot: string
  provider: DatabaseProvider
  source: EpochSourceLocation
  journal: EpochSwitchJournalPort
  sourceExists?: () => Promise<boolean>
  targetState?: (generationId: string) => Promise<'prepared' | 'active' | 'retired' | null>
}): () => Promise<EpochInstallationProbe> {
  return async () => {
    const { bytes, pointer } = readMigrationSourcePointer(input.pointerPath)
    const journals = await input.journal.list()
    const operation =
      [...journals]
        .reverse()
        .find((j) => !['completed', 'rolled-back', 'abandoned'].includes(j.payload.status)) ??
      journals.find((j) => j.payload.operationId === pointer?.payload.operationId) ??
      null
    let rfc349Operation: string | null = null
    if (existsSync(input.migrationsRoot))
      for (const directory of readdirSync(input.migrationsRoot, { withFileTypes: true })) {
        if (!directory.isDirectory()) continue
        const path = join(input.migrationsRoot, directory.name, 'manifest.json')
        if (!existsSync(path)) continue
        const manifest = verifyDatabaseMigrationManifest(JSON.parse(readFileSync(path, 'utf8')))
        if (manifest.payload.phase !== 'finalized' && manifest.payload.rolledBackAt === null) {
          rfc349Operation = manifest.payload.operationId
          break
        }
      }
    const activationBytes = operation
      ? await input.journal.readArtifact(operation.payload.operationId, 'activation-receipt.json')
      : null
    const receipt = activationBytes
      ? parseActivationReceipt(Buffer.from(activationBytes).toString('utf8'))
      : null
    const retired = operation
      ? await input.journal.readArtifact(operation.payload.operationId, 'rollback-retired.json')
      : null
    const retiredGeneration = retired
      ? (JSON.parse(Buffer.from(retired).toString('utf8')) as { generationId: string }).generationId
      : null
    const referencesRetired =
      retiredGeneration !== null && pointer?.payload.generationId === retiredGeneration
    return {
      source: input.source,
      pointerBytes: bytes,
      facts: {
        pointer,
        provider: pointer?.payload.provider ?? input.provider,
        sourceExists: input.sourceExists
          ? await input.sourceExists()
          : input.source.kind === 'sqlite-file'
            ? existsSync(input.source.path)
            : true,
        operation,
        rfc349Operation,
        activationReceiptDigest: receipt?.digest ?? null,
        targetState:
          pointer?.payload.version === 2 && input.targetState
            ? await input.targetState(pointer.payload.generationId)
            : referencesRetired
              ? 'retired'
              : null,
        rollbackIncomplete:
          referencesRetired &&
          operation?.payload.status !== 'rolled-back' &&
          operation?.payload.status !== 'abandoned',
      },
    }
  }
}

export async function readEpochTargetEvidence(
  connection: ConversionTargetConnection,
  generationId: string,
): Promise<{
  state: 'prepared' | 'active' | 'retired'
  activationReceiptDigest: string | null
} | null> {
  const rows = await connection.execute(
    `SELECT state, activation_receipt_digest FROM ${metaTableName(connection.provider, 'generations')} WHERE generation_id = ${parameters(connection, 1)}`,
    [generationId],
  )
  const row = rows[0]
  if (!row) return null
  if (row.state !== 'prepared' && row.state !== 'active' && row.state !== 'retired')
    throw new Error('v3-generation-state-invalid')
  return {
    state: row.state,
    activationReceiptDigest:
      row.activation_receipt_digest === null ? null : String(row.activation_receipt_digest),
  }
}
