// RFC-349 — the single durable one-click migration application used by CLI,
// Settings and recovery. Transport adapters start/query this runner; they do
// not assemble phases, provider operations or cutover rules themselves.

import type {
  DatabaseMigrationControlPlane,
  DatabaseMigrationStatusView,
} from './databaseMigrationControlPlane'
import type { DatabaseMigrationArtifactStorePort } from './ports/databaseMigrationArtifactStore'
import type {
  DatabaseMigrationFailure,
  DatabaseMigrationManifest,
  DatabaseMigrationPhase,
  DatabaseMigrationProgress,
} from '../domain/databaseMigration'
import {
  createLegacyArchiveManifest,
  createLogicalArtifactManifest,
  createLogicalTableChunk,
  summarizeLogicalTableChunks,
  type LogicalDatabaseArtifactManifest,
  type LogicalTableArtifactEntry,
  type LogicalTableChunk,
} from '@/platform/persistence/logicalDatabaseArtifact'
import { writeDatabaseGenerationAtomic } from '@/platform/persistence/generationStore'
import type { PostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { preflightPostgresqlTarget } from '@/platform/persistence/postgresqlPreflight'
import type { PostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import {
  canonicalSchemaJson,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import type {
  SqliteLogicalSource,
  SqliteLogicalSourceSnapshot,
} from '@/platform/persistence/sqliteLogicalSource'
import type { LogicalTargetTableVerification } from '@/platform/persistence/logicalDatabaseRestore'

export interface DatabaseMigrationAdmissionPort {
  freezeAndDrain(input: {
    readonly operationId: string
    readonly sourceGenerationId: string
    readonly timeoutMs: number
  }): Promise<void>
  reopenSqlite(input: {
    readonly operationId: string
    readonly sourceGenerationId: string
  }): Promise<void>
  activatePostgresql(input: {
    readonly operationId: string
    readonly generationId: string
  }): Promise<void>
  openPostgresqlAdmission(input: {
    readonly operationId: string
    readonly generationId: string
  }): Promise<void>
}

export interface DatabaseMigrationSafetyBackupPort {
  create(input: {
    readonly operationId: string
    readonly sourcePath: string
    readonly operationRoot: string
  }): Promise<{ readonly path: string; readonly digest: string }>
}

export interface DatabaseMigrationRunProgress {
  readonly operationId: string
  readonly phase: DatabaseMigrationPhase
  readonly progress: DatabaseMigrationProgress
}

export interface DatabaseMigrationRunner {
  run(
    operationId: string,
    options?: { readonly resumeFailed?: boolean },
  ): Promise<DatabaseMigrationStatusView>
  status(operationId: string): Promise<DatabaseMigrationStatusView>
  rollback(operationId: string): Promise<DatabaseMigrationStatusView>
  finalize(operationId: string): Promise<DatabaseMigrationStatusView>
}

export class DatabaseMigrationRunnerError extends Error {
  constructor(
    public readonly code:
      | 'database-migration-source-mismatch'
      | 'database-migration-manifest-corrupt'
      | 'database-migration-resume-required'
      | 'database-migration-rollback-not-eligible'
      | 'database-migration-finalize-not-ready',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationRunnerError'
  }
}

const BEFORE_SWITCH = new Set<DatabaseMigrationPhase>([
  'planned',
  'preflighted',
  'source-frozen',
  'backed-up',
  'target-prepared',
  'copying',
  'verifying',
  'cutover-prepared',
])

function phaseKey(operationId: string, phase: DatabaseMigrationPhase): string {
  return `${operationId}:${phase}:v1`
}

function owner(manifest: DatabaseMigrationManifest): {
  readonly ownerId: string
  readonly ownerFence: number
} {
  return { ownerId: manifest.payload.owner.id, ownerFence: manifest.payload.owner.fence }
}

function targetGenerationId(operationId: string): string {
  return `dbg_pg_${operationId.slice(4)}`
}

function phaseCommittedAt(
  manifest: DatabaseMigrationManifest,
  phase: DatabaseMigrationPhase,
): number {
  const checkpoint = manifest.payload.checkpoints.find((candidate) => candidate.phase === phase)
  if (checkpoint === undefined) {
    throw new DatabaseMigrationRunnerError(
      'database-migration-manifest-corrupt',
      `database migration manifest is missing the ${phase} checkpoint`,
    )
  }
  return checkpoint.committedAt
}

export function classifyDatabaseMigrationFailure(
  error: unknown,
  phase?: DatabaseMigrationPhase,
): Pick<DatabaseMigrationFailure, 'category' | 'detailCode' | 'retryable'> {
  const codes: string[] = []
  const messages: string[] = []
  let current: unknown = error
  const seen = new Set<object>()
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    if ('sqlState' in current) {
      const candidate = current.sqlState
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        codes.push(String(candidate))
      }
    }
    if ('errno' in current) {
      const candidate = current.errno
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        codes.push(String(candidate))
      }
    }
    if ('code' in current) {
      const candidate = current.code
      if (typeof candidate === 'string' || typeof candidate === 'number') {
        codes.push(String(candidate))
      }
    }
    if ('message' in current && typeof current.message === 'string') {
      messages.push(current.message)
    }
    current = 'cause' in current ? current.cause : undefined
  }
  const code = codes[0] ?? (error instanceof Error ? error.name : 'unknown')
  const detailCode =
    code
      .toLowerCase()
      .replaceAll(/[^a-z0-9._-]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 128) || 'internal'
  const normalized = codes.length > 0 ? codes.join(' ').toLowerCase() : code.toLowerCase()
  const normalizedMessages = messages.join(' ').toLowerCase()
  if (normalized.includes('drain') && normalized.includes('timeout')) {
    return { category: 'drain-timeout', detailCode, retryable: true }
  }
  if (normalized.includes('backup') || normalized.includes('vacuum')) {
    return { category: 'backup-failed', detailCode, retryable: true }
  }
  if (normalized.includes('permission')) {
    return { category: 'target-permission', detailCode, retryable: false }
  }
  if (normalized.includes('codec')) {
    return { category: 'source-codec', detailCode, retryable: false }
  }
  if (
    normalized.includes('source-integrity') ||
    normalized.includes('source-schema') ||
    normalized.includes('source-mutated') ||
    normalized.includes('source-mismatch')
  ) {
    return { category: 'source-integrity', detailCode, retryable: false }
  }
  if (normalized.includes('verification') || normalized.includes('chunk-mismatch')) {
    return { category: 'verification-mismatch', detailCode, retryable: false }
  }
  if (
    normalized.includes('owner') ||
    normalized.includes('lock-held') ||
    normalized.includes('operation-locked')
  ) {
    return { category: 'owner-conflict', detailCode, retryable: true }
  }
  if (normalized.includes('manifest') || normalized.includes('artifact-corrupt')) {
    return { category: 'manifest-corrupt', detailCode, retryable: false }
  }
  const connectivityFailure =
    normalized.includes('unreachable') ||
    normalized.includes('readiness') ||
    normalized.includes('connection') ||
    normalized.includes('socket') ||
    normalized.includes('timeout') ||
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('ehostunreach') ||
    normalized.includes('enetunreach') ||
    normalized.includes('epipe') ||
    (normalized.includes('err_postgres_server_error') &&
      (normalizedMessages.includes('terminating connection') ||
        normalizedMessages.includes('terminated connection') ||
        normalizedMessages.includes('administrator command'))) ||
    codes.some((candidate) => /^08[0-9a-z]{3}$/i.test(candidate)) ||
    codes.some((candidate) =>
      ['40001', '40P01', '57014', '57P01', '57P02', '57P03'].includes(candidate.toUpperCase()),
    )

  if (phase === 'copying') {
    return connectivityFailure
      ? { category: 'copy-transient', detailCode, retryable: true }
      : { category: 'copy-permanent', detailCode, retryable: false }
  }
  if (
    (phase === 'switched' || phase === 'health-checked') &&
    (normalized.includes('health') || normalized.includes('readiness'))
  ) {
    return { category: 'health-failed', detailCode, retryable: true }
  }
  if (
    phase === 'cutover-prepared' ||
    phase === 'switched' ||
    phase === 'health-checked' ||
    phase === 'accepting-writes'
  ) {
    return { category: 'cutover-failed', detailCode, retryable: false }
  }
  if (connectivityFailure) {
    return { category: 'target-unreachable', detailCode, retryable: true }
  }
  if (normalized.includes('target') || normalized.includes('postgresql')) {
    return { category: 'target-schema', detailCode, retryable: false }
  }
  return { category: 'internal', detailCode, retryable: false }
}

function tableEntryFromChunks(
  contract: LogicalSchemaContract,
  tableId: string,
  chunks: readonly LogicalTableChunk[],
): LogicalTableArtifactEntry {
  const table = contract.tables.find((candidate) => candidate.id === tableId)
  if (table === undefined) throw new Error(`unknown logical table ${tableId}`)
  return summarizeLogicalTableChunks({ table, chunks })
}

export function createDatabaseMigrationRunner(deps: {
  readonly controlPlane: DatabaseMigrationControlPlane
  readonly source: SqliteLogicalSource
  readonly sourceSnapshot: SqliteLogicalSourceSnapshot
  readonly target: PostgresqlLogicalTarget
  readonly targetRuntime: PostgresqlDatabaseRuntime
  readonly contract: LogicalSchemaContract
  readonly admission: DatabaseMigrationAdmissionPort
  readonly safetyBackup: DatabaseMigrationSafetyBackupPort
  readonly artifacts: DatabaseMigrationArtifactStorePort
  readonly generationPointerPath: string
  readonly chunkRows?: number
  readonly drainTimeoutMs?: number
  readonly ownerLeaseMs?: number
  readonly now?: () => number
  readonly onProgress?: (event: DatabaseMigrationRunProgress) => void
  readonly preflightTarget?: (
    operationId: string,
  ) => Promise<{ readonly databaseFingerprint: string }>
}): DatabaseMigrationRunner {
  const now = deps.now ?? Date.now
  const chunkRows = deps.chunkRows ?? 250
  const ownerLeaseMs = deps.ownerLeaseMs ?? 60_000
  const targetVerification = (): readonly LogicalTargetTableVerification[] =>
    deps.contract.tables.map((table) => {
      const rowCount = deps.sourceSnapshot.tableRows[table.id]
      if (rowCount === undefined) {
        throw new DatabaseMigrationRunnerError(
          'database-migration-source-mismatch',
          `SQLite source row census is missing ${table.id}`,
        )
      }
      return Object.freeze({
        table: table.id,
        disposition: table.disposition,
        rowCount,
        chunkCount: rowCount === 0 ? 0 : Math.ceil(rowCount / chunkRows),
      })
    })

  const advance = (
    operationId: string,
    nextPhase: DatabaseMigrationPhase,
    extras: Readonly<Record<string, unknown>> = {},
  ): DatabaseMigrationStatusView => {
    const manifest = deps.controlPlane.readManifest(operationId)
    return deps.controlPlane.advance(operationId, {
      expectedPhase: manifest.payload.phase,
      nextPhase,
      ...owner(manifest),
      idempotencyKey: phaseKey(operationId, nextPhase),
      now: now(),
      ...extras,
    })
  }

  const refreshPointer = (operationId: string): void => {
    const manifest = deps.controlPlane.readManifest(operationId)
    const switched = manifest.payload.checkpoints.find(
      (checkpoint) => checkpoint.phase === 'switched',
    )
    writeDatabaseGenerationAtomic({
      pointerPath: deps.generationPointerPath,
      payload: {
        version: 1,
        generationId: targetGenerationId(operationId),
        provider: 'postgresql',
        operationId,
        schemaDigest: deps.contract.digest,
        manifestDigest: deps.artifacts.manifestFileDigest(operationId),
        activatedAt: switched?.committedAt ?? now(),
      },
    })
  }

  const restoreSqliteAfterTargetRetired = async (
    operationId: string,
    generationId: string,
  ): Promise<DatabaseMigrationStatusView> => {
    const manifest = deps.controlPlane.readManifest(operationId)
    // Receipt bodies are immutable write-once artifacts. Derive their time
    // from a durable phase checkpoint so a crash after the file write but
    // before the manifest CAS can replay byte-for-byte.
    const rolledBackAt = phaseCommittedAt(manifest, manifest.payload.phase)
    const receiptDigest = deps.artifacts.writeRollbackReceipt(operationId, {
      version: 1,
      operationId,
      sourceGenerationId: manifest.payload.source.generationId,
      retiredTargetGenerationId: generationId,
      schemaDigest: deps.contract.digest,
      verificationDigest: manifest.payload.verificationDigest,
      firstLiveWriteAt: null,
      rolledBackAt,
    })
    writeDatabaseGenerationAtomic({
      pointerPath: deps.generationPointerPath,
      payload: {
        version: 1,
        generationId: manifest.payload.source.generationId,
        provider: 'sqlite',
        operationId: null,
        schemaDigest: deps.contract.digest,
        manifestDigest: null,
        activatedAt: rolledBackAt,
      },
    })
    const status = deps.controlPlane.markRolledBack(operationId, receiptDigest, rolledBackAt)
    await deps.admission.reopenSqlite({
      operationId,
      sourceGenerationId: manifest.payload.source.generationId,
    })
    return status
  }

  const recordTargetLiveWrite = async (
    operationId: string,
    generationId: string,
  ): Promise<DatabaseMigrationStatusView> => {
    const firstLiveWriteAt = await deps.target.firstLiveWriteAt(generationId)
    if (firstLiveWriteAt !== null) {
      const manifest = deps.controlPlane.readManifest(operationId)
      if (manifest.payload.firstLiveWriteAt === null) {
        deps.controlPlane.markFirstLiveWrite(operationId, firstLiveWriteAt)
      }
      refreshPointer(operationId)
    }
    return deps.controlPlane.get(operationId)
  }

  const copy = async (
    operationId: string,
  ): Promise<{
    readonly manifest: LogicalDatabaseArtifactManifest
    readonly archiveDigest: string
  } | null> => {
    const copyingManifest = deps.controlPlane.readManifest(operationId)
    const artifactCreatedAt = phaseCommittedAt(copyingManifest, 'copying')
    const entries: LogicalTableArtifactEntry[] = []
    let rowsCopied = 0
    let bytesCopied = 0
    let tablesCompleted = 0

    for (const table of deps.contract.tables) {
      if (deps.controlPlane.readManifest(operationId).payload.cancellationRequestedAt !== null) {
        return null
      }
      await deps.source.assertUnchanged(deps.sourceSnapshot)
      const chunks: LogicalTableChunk[] = []
      let afterKey = null
      let chunkIndex = 0
      while (true) {
        const rows = await deps.source.readChunk(table, afterKey, chunkRows)
        if (rows.length === 0) break
        const chunk = createLogicalTableChunk({
          operationId,
          contract: deps.contract,
          table,
          chunkIndex,
          rows,
        })
        const persisted = deps.artifacts.writeTableChunk(operationId, chunk)
        if (table.disposition !== 'ARCHIVE_THEN_OMIT') {
          await deps.target.copyChunk(table, persisted, now())
        }
        if (deps.controlPlane.readManifest(operationId).payload.cancellationRequestedAt !== null) {
          return null
        }
        chunks.push(persisted)
        afterKey = rows.at(-1)!.key
        chunkIndex += 1
        rowsCopied += rows.length
        bytesCopied += Buffer.byteLength(canonicalSchemaJson(persisted), 'utf8')
        deps.onProgress?.({
          operationId,
          phase: 'copying',
          progress: {
            table: table.id,
            chunk: chunkIndex,
            tablesCompleted,
            tablesTotal: deps.contract.tables.length,
            rowsCopied,
            bytesCopied,
            lastMigrationKey: afterKey.map((value) => JSON.stringify(value)),
          },
        })
        if (rows.length < chunkRows) break
      }
      const entry = tableEntryFromChunks(deps.contract, table.id, chunks)
      const expectedRows = deps.sourceSnapshot.tableRows[table.id]
      if (entry.rowCount !== expectedRows) {
        throw new DatabaseMigrationRunnerError(
          'database-migration-source-mismatch',
          `SQLite source row count changed for ${table.id}`,
        )
      }
      entries.push(entry)
      tablesCompleted += 1
      const current = deps.controlPlane.readManifest(operationId)
      deps.controlPlane.checkpoint(operationId, {
        expectedPhase: 'copying',
        ...owner(current),
        idempotencyKey: `${operationId}:copy:${table.id}`,
        now: now(),
        ownerLeaseExpiresAt: now() + ownerLeaseMs,
        progress: {
          table: table.id,
          chunk: chunkIndex,
          tablesCompleted,
          tablesTotal: deps.contract.tables.length,
          rowsCopied,
          bytesCopied,
          lastMigrationKey: afterKey?.map((value) => JSON.stringify(value)) ?? [],
        },
      })
    }
    await deps.source.assertUnchanged(deps.sourceSnapshot)
    const artifactManifest = createLogicalArtifactManifest({
      operationId,
      sourceProvider: 'sqlite',
      sourceGenerationId: deps.controlPlane.readManifest(operationId).payload.source.generationId,
      contract: deps.contract,
      createdAt: artifactCreatedAt,
      tables: entries,
    })
    deps.artifacts.writeLogicalManifest(operationId, artifactManifest)
    const archiveEntries = entries.filter((entry) => entry.disposition === 'ARCHIVE_THEN_OMIT')
    const archiveDigest = deps.artifacts.writeLegacyArchiveManifest(
      operationId,
      createLegacyArchiveManifest({
        operationId,
        schemaDigest: deps.contract.digest,
        tables: archiveEntries,
      }),
    )
    return { manifest: artifactManifest, archiveDigest }
  }

  const runner: DatabaseMigrationRunner = {
    async run(operationId, options) {
      let manifest = deps.controlPlane.readManifest(operationId)
      if (manifest.payload.source.databaseFingerprint !== deps.sourceSnapshot.databaseFingerprint) {
        throw new DatabaseMigrationRunnerError(
          'database-migration-source-mismatch',
          'migration operation source fingerprint differs from the frozen SQLite source',
        )
      }
      if (manifest.payload.rolledBackAt !== null) {
        await deps.admission.reopenSqlite({
          operationId,
          sourceGenerationId: manifest.payload.source.generationId,
        })
        return deps.controlPlane.get(operationId)
      }
      if (manifest.payload.failure !== null) {
        if (options?.resumeFailed !== true) {
          throw new DatabaseMigrationRunnerError(
            'database-migration-resume-required',
            'database migration is failed or cancelled and requires an explicit resume',
          )
        }
        deps.controlPlane.resume(operationId, {
          requesterOwnerId: manifest.payload.owner.id,
          ownerLeaseMs,
          now: now(),
        })
      }

      try {
        while (true) {
          manifest = deps.controlPlane.readManifest(operationId)
          if (manifest.payload.cancellationRequestedAt !== null) {
            const status = deps.controlPlane.settleCancelled(operationId, now())
            if (BEFORE_SWITCH.has(manifest.payload.phase)) {
              await deps.admission.reopenSqlite({
                operationId,
                sourceGenerationId: manifest.payload.source.generationId,
              })
            }
            return status
          }

          switch (manifest.payload.phase) {
            case 'planned': {
              await deps.source.assertUnchanged(deps.sourceSnapshot)
              const health = await (deps.preflightTarget === undefined
                ? preflightPostgresqlTarget({ runtime: deps.targetRuntime, operationId })
                : deps.preflightTarget(operationId))
              advance(operationId, 'preflighted', {
                targetDatabaseFingerprint: health.databaseFingerprint,
              })
              break
            }
            case 'preflighted':
              await deps.admission.freezeAndDrain({
                operationId,
                sourceGenerationId: manifest.payload.source.generationId,
                timeoutMs: deps.drainTimeoutMs ?? 30_000,
              })
              await deps.source.assertUnchanged(deps.sourceSnapshot)
              advance(operationId, 'source-frozen')
              break
            case 'source-frozen': {
              const backup = await deps.safetyBackup.create({
                operationId,
                sourcePath: deps.source.path,
                operationRoot: deps.artifacts.operationRoot(operationId),
              })
              advance(operationId, 'backed-up', { sourceBackupDigest: backup.digest })
              break
            }
            case 'backed-up':
              await deps.target.prepare(now())
              advance(operationId, 'target-prepared')
              break
            case 'target-prepared':
              advance(operationId, 'copying')
              break
            case 'copying': {
              const copied = await copy(operationId)
              if (copied === null) continue
              advance(operationId, 'verifying', {
                logicalBackupDigest: copied.manifest.digest,
                legacyArchiveDigest: copied.archiveDigest,
              })
              break
            }
            case 'verifying': {
              await deps.source.assertUnchanged(deps.sourceSnapshot)
              await deps.target.finalizeSchema(now(), targetVerification())
              const generationId = targetGenerationId(operationId)
              await deps.target.prepareGeneration({
                generationId,
                sourceGenerationId: manifest.payload.source.generationId,
              })
              const verificationDigest = deps.artifacts.writeVerificationReceipt(operationId, {
                version: 1,
                operationId,
                sourceGenerationId: manifest.payload.source.generationId,
                sourceFingerprint: deps.sourceSnapshot.databaseFingerprint,
                targetFingerprint: manifest.payload.target.databaseFingerprint,
                schemaDigest: deps.contract.digest,
                logicalBackupDigest: manifest.payload.logicalBackupDigest,
                legacyArchiveDigest: manifest.payload.legacyArchiveDigest,
                activeTableCount: deps.contract.activeTableCount,
                archiveOnlyTableCount: deps.contract.archiveOnlyTableCount,
                verifiedAt: phaseCommittedAt(manifest, 'verifying'),
              })
              advance(operationId, 'cutover-prepared', { verificationDigest })
              break
            }
            case 'cutover-prepared':
              advance(operationId, 'switched')
              break
            case 'switched': {
              const generationId = targetGenerationId(operationId)
              refreshPointer(operationId)
              await deps.target.activateGeneration(generationId, now())
              // The logical target owns the operation-scoped advisory-lock
              // session through cutover. Probe the active generation and one
              // representative read on that same session so poolMax=1 cannot
              // deadlock waiting for a second connection.
              await deps.target.assertReady(generationId)
              advance(operationId, 'health-checked')
              refreshPointer(operationId)
              break
            }
            case 'health-checked': {
              const generationId = targetGenerationId(operationId)
              await deps.admission.activatePostgresql({ operationId, generationId })
              advance(operationId, 'accepting-writes')
              refreshPointer(operationId)
              await deps.admission.openPostgresqlAdmission({ operationId, generationId })
              return deps.controlPlane.get(operationId)
            }
            case 'accepting-writes':
            case 'finalized':
              return deps.controlPlane.get(operationId)
          }
        }
      } catch (error) {
        const current = deps.controlPlane.readManifest(operationId)
        if (current.payload.failure === null) {
          const failure = classifyDatabaseMigrationFailure(error, current.payload.phase)
          deps.controlPlane.fail(operationId, {
            ...owner(current),
            ...failure,
            retryCount: 0,
            nextRetryAt: failure.retryable ? now() + 1_000 : null,
            now: now(),
          })
        }
        if (
          current.payload.phase === 'switched' ||
          current.payload.phase === 'health-checked' ||
          current.payload.phase === 'accepting-writes'
        ) {
          try {
            const generationId = targetGenerationId(operationId)
            if (await deps.target.retireGenerationIfUnwritten(generationId)) {
              await restoreSqliteAfterTargetRetired(operationId, generationId)
            } else {
              await recordTargetLiveWrite(operationId, generationId)
            }
          } catch {
            // The original migration failure remains authoritative. A later
            // recovery pass resumes the idempotent target/pointer rollback.
          }
        } else if (BEFORE_SWITCH.has(current.payload.phase)) {
          try {
            await deps.admission.reopenSqlite({
              operationId,
              sourceGenerationId: current.payload.source.generationId,
            })
          } catch {
            // The migration failure remains authoritative; admission stays closed.
          }
        }
        throw error
      }
    },

    async status(operationId) {
      let manifest = deps.controlPlane.readManifest(operationId)
      if (manifest.payload.rolledBackAt !== null) {
        return deps.controlPlane.get(operationId)
      }
      if (
        (manifest.payload.phase === 'switched' ||
          manifest.payload.phase === 'health-checked' ||
          manifest.payload.phase === 'accepting-writes') &&
        manifest.payload.firstLiveWriteAt === null
      ) {
        const firstLiveWriteAt = await deps.target.firstLiveWriteAt(targetGenerationId(operationId))
        if (firstLiveWriteAt !== null) {
          deps.controlPlane.markFirstLiveWrite(operationId, firstLiveWriteAt)
          refreshPointer(operationId)
          manifest = deps.controlPlane.readManifest(operationId)
        }
      }
      return deps.controlPlane.get(manifest.payload.operationId)
    },

    async rollback(operationId) {
      let status = await runner.status(operationId)
      if (status.rolledBackAt !== null) {
        await deps.admission.reopenSqlite({
          operationId,
          sourceGenerationId: status.sourceGenerationId,
        })
        return status
      }
      if (!status.rollback.eligible) {
        throw new DatabaseMigrationRunnerError(
          'database-migration-rollback-not-eligible',
          `instant rollback is not eligible: ${status.rollback.reason}`,
        )
      }

      const generationId = targetGenerationId(operationId)
      await deps.admission.freezeAndDrain({
        operationId,
        sourceGenerationId: status.sourceGenerationId,
        timeoutMs: deps.drainTimeoutMs ?? 30_000,
      })
      let targetRetired = false
      try {
        targetRetired = await deps.target.retireGenerationIfUnwritten(generationId)
        if (!targetRetired) {
          status = await recordTargetLiveWrite(operationId, generationId)
          throw new DatabaseMigrationRunnerError(
            'database-migration-rollback-not-eligible',
            `instant rollback is not eligible: ${status.rollback.reason}`,
          )
        }
        return await restoreSqliteAfterTargetRetired(operationId, generationId)
      } catch (error) {
        if (!targetRetired) {
          try {
            await deps.admission.openPostgresqlAdmission({ operationId, generationId })
          } catch {
            // The rollback error remains authoritative; admission fails closed.
          }
        }
        throw error
      }
    },

    async finalize(operationId) {
      await runner.status(operationId)
      const manifest = deps.controlPlane.readManifest(operationId)
      if (manifest.payload.rolledBackAt !== null) {
        throw new DatabaseMigrationRunnerError(
          'database-migration-finalize-not-ready',
          'a rolled-back database migration cannot be finalized',
        )
      }
      if (manifest.payload.phase !== 'accepting-writes') {
        if (manifest.payload.phase === 'finalized') {
          const finalizedAt = phaseCommittedAt(manifest, 'accepting-writes')
          await deps.target.markFinalized(finalizedAt)
          refreshPointer(operationId)
          return deps.controlPlane.get(operationId)
        }
        throw new DatabaseMigrationRunnerError(
          'database-migration-finalize-not-ready',
          'database migration can only finalize after PostgreSQL is accepting writes',
        )
      }
      const finalizedAt = phaseCommittedAt(manifest, 'accepting-writes')
      const receiptDigest = deps.artifacts.writeFinalReceipt(operationId, {
        version: 1,
        operationId,
        sourceGenerationId: manifest.payload.source.generationId,
        targetGenerationId: targetGenerationId(operationId),
        schemaDigest: deps.contract.digest,
        logicalBackupDigest: manifest.payload.logicalBackupDigest,
        legacyArchiveDigest: manifest.payload.legacyArchiveDigest,
        verificationDigest: manifest.payload.verificationDigest,
        firstLiveWriteAt: manifest.payload.firstLiveWriteAt,
        finalizedAt,
      })
      // Commit target metadata first. If the process dies before the external
      // manifest advances, markFinalized and the write-once receipt both
      // replay idempotently from the accepting-writes checkpoint.
      await deps.target.markFinalized(finalizedAt)
      const status = advance(operationId, 'finalized', { receiptDigest })
      refreshPointer(operationId)
      return status
    },
  }
  return Object.freeze(runner)
}
