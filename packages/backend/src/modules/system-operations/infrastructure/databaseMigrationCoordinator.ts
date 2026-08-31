// RFC-349 — production coordinator for the durable one-click operation. It is
// the only place that assembles source, target, control-plane and admission
// mechanisms; public commands never receive provider clients or transactions.

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import type { DatabaseConfig } from '@agent-workflow/shared'
import { createDatabaseMigrationControlPlane } from '../application/databaseMigrationControlPlane'
import {
  classifyDatabaseMigrationFailure,
  createDatabaseMigrationRunner,
  type DatabaseMigrationAdmissionPort,
  type DatabaseMigrationSafetyBackupPort,
} from '../application/databaseMigrationRunner'
import type { DatabaseMigrationCoordinatorPort } from '../application/ports/databaseMigrationCoordinator'
import { createFileDatabaseMigrationStore } from './fileDatabaseMigrationStore'
import { createFileDatabaseMigrationArtifactStore } from './fileDatabaseMigrationArtifactStore'
import { createDatabaseMigrationArtifactReader } from './databaseMigrationArtifactReader'
import { createSqliteMigrationSafetyBackup } from './sqliteMigrationSafetyBackup'
import type {
  DatabaseMigrationOperationInput,
  DatabaseMigrationPreflightInput,
  DatabaseMigrationPreflightView,
  DatabaseMigrationStatusView,
  DatabaseMigrationTargetView,
  DatabaseRuntimeOverview,
  StartDatabaseMigrationInput,
} from '../public/types'
import { readDatabaseGeneration } from '@/platform/persistence/generationStore'
import { openPostgresqlLogicalTarget } from '@/platform/persistence/postgresqlLogicalTarget'
import { createPostgresqlDatabaseRuntime } from '@/platform/persistence/postgresqlRuntime'
import { preflightPostgresqlTarget } from '@/platform/persistence/postgresqlPreflight'
import { buildPostgresqlSchemaPlan } from '@/platform/persistence/postgresqlSchema'
import {
  buildLogicalSchemaContract,
  type LogicalSchemaContract,
} from '@/platform/persistence/schemaContract'
import type {
  SqliteLogicalSource,
  SqliteLogicalSourceSnapshot,
} from '@/platform/persistence/sqliteLogicalSource'
import { openSqliteLogicalSourceWorker } from '@/platform/persistence/sqliteLogicalSourceWorkerSupervisor'

type PostgresqlConfig = Extract<DatabaseConfig, { provider: 'postgresql' }>

export class DatabaseMigrationCoordinatorError extends Error {
  constructor(
    public readonly code:
      | 'database-migration-source-not-sqlite'
      | 'database-migration-target-config-mismatch'
      | 'database-migration-auto-resume-blocked',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationCoordinatorError'
  }
}

export interface DatabaseMigrationCoordinatorOptions {
  readonly sqlitePath: string
  readonly operationsRoot: string
  readonly generationPointerPath: string
  readonly contract?: LogicalSchemaContract
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly admission: DatabaseMigrationAdmissionPort
  readonly safetyBackup?: DatabaseMigrationSafetyBackupPort
  /** Persist the safe target config at cutover; the URL value is never passed. */
  readonly activateTargetConfig: (target: DatabaseMigrationTargetView) => Promise<void> | void
  /** Restore the provider selector only after a durable instant rollback. */
  readonly activateSourceConfig: () => Promise<void> | void
  /** HTTP/Settings returns the durable planned status and runs in-process in
   * the background; offline CLI and boot recovery keep inline completion. */
  readonly executionMode?: 'inline' | 'background'
  readonly onBackgroundFailure?: (input: {
    readonly operationId: string
    readonly error: unknown
  }) => void
  readonly now?: () => number
}

function targetConfig(target: DatabaseMigrationTargetView): PostgresqlConfig {
  return {
    provider: 'postgresql',
    urlEnv: target.urlEnv,
    poolMax: target.poolMax,
    connectTimeoutMs: target.connectTimeoutMs,
    statementTimeoutMs: target.statementTimeoutMs,
    idleTimeoutMs: target.idleTimeoutMs,
  }
}

function sameTarget(
  left: DatabaseMigrationTargetView,
  right: DatabaseMigrationTargetView,
): boolean {
  return (
    left.provider === right.provider &&
    left.urlEnv === right.urlEnv &&
    left.poolMax === right.poolMax &&
    left.connectTimeoutMs === right.connectTimeoutMs &&
    left.statementTimeoutMs === right.statementTimeoutMs &&
    left.idleTimeoutMs === right.idleTimeoutMs
  )
}

export function createDatabaseMigrationCoordinator(
  options: DatabaseMigrationCoordinatorOptions,
): DatabaseMigrationCoordinatorPort {
  const contract = options.contract ?? buildLogicalSchemaContract()
  const plan = buildPostgresqlSchemaPlan(contract)
  const store = createFileDatabaseMigrationStore({ root: options.operationsRoot })
  const controlPlane = createDatabaseMigrationControlPlane({ store })
  const artifacts = createFileDatabaseMigrationArtifactStore({
    operationsRoot: options.operationsRoot,
  })
  const artifactReader = createDatabaseMigrationArtifactReader({
    operationsRoot: options.operationsRoot,
    controlPlane,
    contract,
  })
  const safetyBackup = options.safetyBackup ?? createSqliteMigrationSafetyBackup()
  const now = options.now ?? Date.now
  // A daemon owns one coordinator instance. Keep execution singular so
  // duplicate resume requests cannot race the same durable owner fence, and
  // let the active runner settle cancellation at a safe phase/chunk boundary.
  const activeRuns = new Map<string, Promise<DatabaseMigrationStatusView>>()

  const liveGeneration = () =>
    readDatabaseGeneration({
      pointerPath: options.generationPointerPath,
      migrationsDir: options.operationsRoot,
      expectedSchemaDigest: contract.digest,
    })

  const assertSqliteSource = (): string => {
    const generation = liveGeneration().payload
    if (generation.provider !== 'sqlite') {
      throw new DatabaseMigrationCoordinatorError(
        'database-migration-source-not-sqlite',
        'one-click migration requires the live database generation to be SQLite',
      )
    }
    return generation.generationId
  }

  const inspectSqliteSource = async () => {
    const source = await openSqliteLogicalSourceWorker({ path: options.sqlitePath, contract })
    try {
      return await source.preflight()
    } finally {
      await source.close()
    }
  }

  /** Lightweight polling projection. Full integrity/FK/184-table counts are
   * reserved for explicit preflight so Settings cannot recreate an hourly scan. */
  const inspectRetainedSqlite = (sourceGenerationId: string): DatabaseRuntimeOverview['source'] => {
    if (!existsSync(options.sqlitePath)) return null
    const stat = statSync(options.sqlitePath)
    const latest = controlPlane
      .list()
      .filter((status) => status.sourceGenerationId === sourceGenerationId)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0]
    const databaseFingerprint =
      latest === undefined
        ? `sqlite-file:${createHash('sha256')
            .update(`${contract.digest}:${stat.size}:${stat.mtimeMs}`)
            .digest('hex')
            .slice(0, 24)}`
        : controlPlane.readManifest(latest.operationId).payload.source.databaseFingerprint
    return Object.freeze({
      databaseFingerprint,
      fileBytes: stat.size,
      totalRows:
        latest !== undefined && latest.progress.tablesCompleted === latest.tableCounts.source
          ? latest.progress.rowsCopied
          : null,
    })
  }

  const withRunner = async <T>(
    operationId: string,
    operation: (runner: ReturnType<typeof createDatabaseMigrationRunner>) => Promise<T>,
    requireSourcePreflight = true,
  ): Promise<T> => {
    const manifest = controlPlane.readManifest(operationId)
    const target = manifest.payload.target
    const source: SqliteLogicalSource = requireSourcePreflight
      ? await openSqliteLogicalSourceWorker({ path: options.sqlitePath, contract })
      : {
          provider: 'sqlite',
          path: options.sqlitePath,
          preflight() {
            throw new Error('SQLite source preflight is unavailable in status-only mode')
          },
          assertUnchanged() {
            throw new Error('SQLite source mutation checks are unavailable in status-only mode')
          },
          readChunk() {
            throw new Error('SQLite source reads are unavailable in status-only mode')
          },
          async close() {},
        }
    const sourceSnapshot: SqliteLogicalSourceSnapshot = requireSourcePreflight
      ? await source.preflight()
      : {
          databaseFingerprint: manifest.payload.source.databaseFingerprint,
          dataVersion: 0,
          pageCount: 0,
          pageSize: 0,
          fileBytes: 0,
          totalRows: 0,
          tableRows: Object.freeze({}),
        }
    const runtime = createPostgresqlDatabaseRuntime({
      config: targetConfig(target),
      generationId: `dbg_pg_${operationId.slice(4)}`,
      env: options.env,
    })
    const logicalTarget = await openPostgresqlLogicalTarget({
      runtime,
      operationId,
      sourceGenerationId: manifest.payload.source.generationId,
      contract,
      plan,
    })
    const admission: DatabaseMigrationAdmissionPort = {
      freezeAndDrain: (input) => options.admission.freezeAndDrain(input),
      async reopenSqlite(input) {
        await options.activateSourceConfig()
        await options.admission.reopenSqlite(input)
      },
      async activatePostgresql(input) {
        await options.activateTargetConfig(targetConfig(target))
        await options.admission.activatePostgresql(input)
      },
      openPostgresqlAdmission: (input) => options.admission.openPostgresqlAdmission(input),
    }
    const runner = createDatabaseMigrationRunner({
      controlPlane,
      source,
      sourceSnapshot,
      target: logicalTarget,
      targetRuntime: runtime,
      contract,
      admission,
      safetyBackup,
      artifacts,
      generationPointerPath: options.generationPointerPath,
      now,
    })
    try {
      return await operation(runner)
    } finally {
      await logicalTarget.close()
      await source.close()
      await runtime.close()
    }
  }

  const runOperation = (
    operationId: string,
    runOptions?: { readonly resumeFailed?: boolean },
  ): Promise<DatabaseMigrationStatusView> => {
    const active = activeRuns.get(operationId)
    if (active !== undefined) return active
    const run = (async () => {
      try {
        return await withRunner(operationId, (runner) => runner.run(operationId, runOptions))
      } catch (error) {
        // Source Worker / PostgreSQL runtime / history / target construction
        // happens before a runner exists. Persist those failures too; otherwise
        // a connection refusal or missing compiled asset strands the operation
        // forever in `planned` with no resumable failure receipt.
        const manifest = controlPlane.readManifest(operationId)
        if (manifest.payload.failure === null) {
          const failure = classifyDatabaseMigrationFailure(error)
          controlPlane.fail(operationId, {
            ownerId: manifest.payload.owner.id,
            ownerFence: manifest.payload.owner.fence,
            ...failure,
            retryCount: 0,
            nextRetryAt: failure.retryable ? now() + 1_000 : null,
            now: now(),
          })
        }
        throw error
      } finally {
        activeRuns.delete(operationId)
      }
    })()
    activeRuns.set(operationId, run)
    return run
  }

  const executeOperation = async (
    operationId: string,
    runOptions?: { readonly resumeFailed?: boolean },
  ): Promise<DatabaseMigrationStatusView> => {
    const run = runOperation(operationId, runOptions)
    if (options.executionMode !== 'background') return await run
    void run.catch((error) => options.onBackgroundFailure?.({ operationId, error }))
    return controlPlane.get(operationId)
  }

  const coordinator: DatabaseMigrationCoordinatorPort = {
    async preflight(
      input: DatabaseMigrationPreflightInput,
    ): Promise<DatabaseMigrationPreflightView> {
      assertSqliteSource()
      const source = await inspectSqliteSource()
      const token = randomUUID().replaceAll('-', '')
      const runtime = createPostgresqlDatabaseRuntime({
        config: targetConfig(input.target),
        generationId: `dbg_preflight_${token}`,
        env: options.env,
      })
      try {
        const target = await preflightPostgresqlTarget({
          runtime,
          operationId: `dbm_preflight_${token}`,
        })
        return Object.freeze({
          ...target,
          sourceDatabaseFingerprint: source.databaseFingerprint,
          sourceBytes: source.fileBytes,
          sourceRows: source.totalRows,
          tableCounts: Object.freeze({
            source: contract.tables.length,
            active: contract.activeTableCount,
            archiveOnly: contract.archiveOnlyTableCount,
          }),
        })
      } finally {
        await runtime.close()
      }
    },

    async start(input: StartDatabaseMigrationInput) {
      const duplicate = controlPlane
        .list()
        .map((status) => controlPlane.readManifest(status.operationId))
        .find((manifest) => manifest.payload.idempotencyKey === input.idempotencyKey)
      if (duplicate !== undefined) {
        if (!sameTarget(duplicate.payload.target, input.target)) {
          throw new DatabaseMigrationCoordinatorError(
            'database-migration-target-config-mismatch',
            'idempotent migration start reused an operation with a different target config',
          )
        }
        const status = await coordinator.get({ operationId: duplicate.payload.operationId })
        if (
          status.failure === null &&
          status.rolledBackAt === null &&
          status.phase !== 'accepting-writes' &&
          status.phase !== 'finalized'
        ) {
          return await executeOperation(status.operationId)
        }
        return status
      }
      const sourceGenerationId = assertSqliteSource()
      const sourceSnapshot = await inspectSqliteSource()
      const status = controlPlane.start({
        idempotencyKey: input.idempotencyKey,
        sourceGenerationId,
        sourceSchemaDigest: contract.digest,
        sourceDatabaseFingerprint: sourceSnapshot.databaseFingerprint,
        target: input.target,
        tableCounts: {
          source: contract.tables.length,
          active: contract.activeTableCount,
          archiveOnly: contract.archiveOnlyTableCount,
        },
        ownerLeaseMs: 60_000,
        now: now(),
      })
      const manifest = controlPlane.readManifest(status.operationId)
      if (!sameTarget(manifest.payload.target, input.target)) {
        throw new DatabaseMigrationCoordinatorError(
          'database-migration-target-config-mismatch',
          'idempotent migration start reused an operation with a different target config',
        )
      }
      return await executeOperation(status.operationId)
    },

    async resume(input: DatabaseMigrationOperationInput) {
      assertSqliteSource()
      return await executeOperation(input.operationId, { resumeFailed: true })
    },

    async cancel(input: DatabaseMigrationOperationInput) {
      const requested = controlPlane.requestCancel(input.operationId, now())
      if (activeRuns.has(input.operationId)) return requested
      const settled = controlPlane.settleCancelled(input.operationId, now())
      await options.activateSourceConfig()
      await options.admission.reopenSqlite({
        operationId: input.operationId,
        sourceGenerationId: settled.sourceGenerationId,
      })
      return settled
    },

    async rollback(input: DatabaseMigrationOperationInput) {
      return await withRunner(
        input.operationId,
        (runner) => runner.rollback(input.operationId),
        false,
      )
    },

    async finalize(input: DatabaseMigrationOperationInput) {
      return await withRunner(
        input.operationId,
        (runner) => runner.finalize(input.operationId),
        false,
      )
    },

    async get(input: DatabaseMigrationOperationInput) {
      const status = controlPlane.get(input.operationId)
      if (status.phase !== 'accepting-writes') return status
      return await withRunner(
        input.operationId,
        (runner) => runner.status(input.operationId),
        false,
      )
    },

    async list() {
      const statuses = controlPlane.list()
      const projected = []
      for (const status of statuses) {
        projected.push(
          status.phase === 'accepting-writes' && status.rolledBackAt === null
            ? await withRunner(
                status.operationId,
                (runner) => runner.status(status.operationId),
                false,
              )
            : status,
        )
      }
      return projected
    },

    async overview(): Promise<DatabaseRuntimeOverview> {
      const generation = liveGeneration().payload
      const postgresqlOperationId =
        generation.provider === 'postgresql' ? generation.operationId : null
      let sourceGenerationId = generation.generationId
      if (generation.provider === 'postgresql') {
        if (postgresqlOperationId === null) {
          throw new DatabaseMigrationCoordinatorError(
            'database-migration-target-config-mismatch',
            'PostgreSQL live generation is missing its migration operation',
          )
        }
        sourceGenerationId =
          controlPlane.readManifest(postgresqlOperationId).payload.source.generationId
      }
      const source = inspectRetainedSqlite(sourceGenerationId)

      let databaseFingerprint =
        generation.provider === 'sqlite' ? (source?.databaseFingerprint ?? null) : null
      let serverVersion: string | null = null
      let target: DatabaseMigrationTargetView | null = null
      if (generation.provider === 'postgresql' && postgresqlOperationId !== null) {
        const manifest = controlPlane.readManifest(postgresqlOperationId)
        target = targetConfig(manifest.payload.target)
        const runtime = createPostgresqlDatabaseRuntime({
          config: targetConfig(target),
          generationId: generation.generationId,
          env: options.env,
        })
        try {
          const health = await runtime.health()
          databaseFingerprint = health.databaseFingerprint
          serverVersion = health.serverVersion
        } finally {
          await runtime.close()
        }
      }
      return Object.freeze({
        provider: generation.provider,
        generationId: generation.generationId,
        schemaDigest: generation.schemaDigest,
        databaseFingerprint,
        serverVersion,
        operationId: generation.operationId,
        target,
        source,
        tableCounts: Object.freeze({
          source: contract.tables.length,
          active: contract.activeTableCount,
          archiveOnly: contract.archiveOnlyTableCount,
        }),
      })
    },

    async readArtifact(input) {
      return artifactReader.readArtifact(input)
    },

    async inspectLegacyTable(input) {
      return artifactReader.inspectLegacyTable(input)
    },

    async readLegacyChunk(input) {
      return artifactReader.readLegacyChunk(input)
    },

    async resumeInterrupted(target: DatabaseMigrationTargetView) {
      const candidate = controlPlane
        .list()
        .filter((status) => status.phase !== 'finalized' && status.rolledBackAt === null)
        .sort((left, right) => right.updatedAt - left.updatedAt)[0]
      if (candidate === undefined) return null
      if (!sameTarget(candidate.target, target)) {
        throw new DatabaseMigrationCoordinatorError(
          'database-migration-target-config-mismatch',
          'interrupted migration target differs from the requested boot target',
        )
      }
      if (candidate.failure !== null && !candidate.resumeEligible) {
        throw new DatabaseMigrationCoordinatorError(
          'database-migration-auto-resume-blocked',
          `database migration ${candidate.operationId} requires operator intervention`,
        )
      }
      return await runOperation(candidate.operationId, {
        resumeFailed: candidate.failure !== null,
      })
    },
  }
  return Object.freeze(coordinator)
}
