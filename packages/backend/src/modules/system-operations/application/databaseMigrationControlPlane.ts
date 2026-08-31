// RFC-349 — single application control plane shared by Settings, CLI and the
// migration runner. It owns idempotent start, one-active-operation admission,
// CAS persistence, lease takeover and phase mutation; adapters never assemble
// these rules independently.

import { ulid } from 'ulid'
import type { DatabaseMigrationStorePort } from './ports/databaseMigrationStore'
import {
  advanceDatabaseMigration,
  checkpointDatabaseMigration,
  createDatabaseMigrationManifest,
  databaseRollbackEligibility,
  failDatabaseMigration,
  markDatabaseFirstLiveWrite,
  markDatabaseMigrationRolledBack,
  markDatabaseMigrationCancelled,
  requestDatabaseMigrationCancellation,
  resumeDatabaseMigration,
  type AdvanceDatabaseMigrationInput,
  type CheckpointDatabaseMigrationInput,
  type DatabaseMigrationFailure,
  type DatabaseMigrationManifest,
  type DatabaseMigrationPhase,
  type DatabaseMigrationProgress,
  type DatabaseMigrationTargetConfig,
} from '../domain/databaseMigration'

export class DatabaseMigrationControlPlaneError extends Error {
  constructor(
    public readonly code:
      | 'database-migration-active'
      | 'database-migration-not-found'
      | 'database-migration-lease-active',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationControlPlaneError'
  }
}

export interface DatabaseMigrationStatusView {
  readonly operationId: string
  readonly revision: number
  readonly phase: DatabaseMigrationPhase
  readonly sourceGenerationId: string
  readonly targetProvider: 'postgresql'
  readonly targetUrlEnv: string
  readonly target: DatabaseMigrationTargetConfig
  readonly targetDatabaseFingerprint: string | null
  readonly tableCounts: {
    readonly source: number
    readonly active: number
    readonly archiveOnly: number
  }
  readonly progress: DatabaseMigrationProgress
  readonly failure: DatabaseMigrationFailure | null
  readonly cancelEligible: boolean
  readonly resumeEligible: boolean
  readonly rollback: ReturnType<typeof databaseRollbackEligibility>
  readonly firstLiveWriteAt: number | null
  readonly rolledBackAt: number | null
  readonly rollbackReceiptDigest: string | null
  readonly createdAt: number
  readonly updatedAt: number
}

function view(manifest: DatabaseMigrationManifest): DatabaseMigrationStatusView {
  const cancelEligible =
    manifest.payload.cancelledAt === null &&
    manifest.payload.cancellationRequestedAt === null &&
    [
      'planned',
      'preflighted',
      'source-frozen',
      'backed-up',
      'target-prepared',
      'copying',
      'verifying',
    ].includes(manifest.payload.phase)
  return Object.freeze({
    operationId: manifest.payload.operationId,
    revision: manifest.payload.revision,
    phase: manifest.payload.phase,
    sourceGenerationId: manifest.payload.source.generationId,
    targetProvider: 'postgresql' as const,
    targetUrlEnv: manifest.payload.target.urlEnv,
    target: Object.freeze({
      provider: 'postgresql' as const,
      urlEnv: manifest.payload.target.urlEnv,
      poolMax: manifest.payload.target.poolMax,
      connectTimeoutMs: manifest.payload.target.connectTimeoutMs,
      statementTimeoutMs: manifest.payload.target.statementTimeoutMs,
      idleTimeoutMs: manifest.payload.target.idleTimeoutMs,
    }),
    targetDatabaseFingerprint: manifest.payload.target.databaseFingerprint,
    tableCounts: Object.freeze({ ...manifest.payload.tableCounts }),
    progress: Object.freeze({ ...manifest.payload.progress }),
    failure:
      manifest.payload.failure === null ? null : Object.freeze({ ...manifest.payload.failure }),
    cancelEligible,
    resumeEligible:
      manifest.payload.failure?.retryable === true || manifest.payload.cancelledAt !== null,
    rollback: Object.freeze(databaseRollbackEligibility(manifest)),
    firstLiveWriteAt: manifest.payload.firstLiveWriteAt,
    rolledBackAt: manifest.payload.rolledBackAt,
    rollbackReceiptDigest: manifest.payload.rollbackReceiptDigest,
    createdAt: manifest.payload.createdAt,
    updatedAt: manifest.payload.updatedAt,
  })
}

export interface DatabaseMigrationControlPlane {
  start(input: {
    readonly idempotencyKey: string
    readonly sourceGenerationId: string
    readonly sourceSchemaDigest: string
    readonly sourceDatabaseFingerprint: string
    readonly target: DatabaseMigrationTargetConfig
    readonly tableCounts: {
      readonly source: number
      readonly active: number
      readonly archiveOnly: number
    }
    readonly ownerLeaseMs: number
    readonly now: number
  }): DatabaseMigrationStatusView
  get(operationId: string): DatabaseMigrationStatusView
  list(): readonly DatabaseMigrationStatusView[]
  advance(
    operationId: string,
    input: Omit<AdvanceDatabaseMigrationInput, 'expectedRevision'>,
  ): DatabaseMigrationStatusView
  checkpoint(
    operationId: string,
    input: Omit<CheckpointDatabaseMigrationInput, 'expectedRevision'>,
  ): DatabaseMigrationStatusView
  fail(
    operationId: string,
    input: Readonly<{
      category: DatabaseMigrationFailure['category']
      detailCode: string
      retryable: boolean
      retryCount: number
      nextRetryAt: number | null
      now: number
      ownerId: string
      ownerFence: number
    }>,
  ): DatabaseMigrationStatusView
  resume(
    operationId: string,
    input: Readonly<{ requesterOwnerId?: string; ownerLeaseMs: number; now: number }>,
  ): DatabaseMigrationStatusView
  requestCancel(operationId: string, now: number): DatabaseMigrationStatusView
  settleCancelled(operationId: string, now: number): DatabaseMigrationStatusView
  markFirstLiveWrite(operationId: string, now: number): DatabaseMigrationStatusView
  markRolledBack(
    operationId: string,
    receiptDigest: string,
    now: number,
  ): DatabaseMigrationStatusView
  readManifest(operationId: string): DatabaseMigrationManifest
}

export function createDatabaseMigrationControlPlane(deps: {
  readonly store: DatabaseMigrationStorePort
  readonly newOperationId?: () => string
  readonly newOwnerId?: () => string
}): DatabaseMigrationControlPlane {
  const newOperationId = deps.newOperationId ?? (() => `dbm_${ulid()}`)
  const newOwnerId = deps.newOwnerId ?? (() => `dbo_${ulid()}`)

  const readRequired = (operationId: string): DatabaseMigrationManifest => {
    const manifest = deps.store.read(operationId)
    if (manifest === null) {
      throw new DatabaseMigrationControlPlaneError(
        'database-migration-not-found',
        `database migration operation not found: ${operationId}`,
      )
    }
    return manifest
  }

  const cas = (
    current: DatabaseMigrationManifest,
    next: DatabaseMigrationManifest,
  ): DatabaseMigrationManifest => {
    if (current.digest === next.digest) return current
    return deps.store.compareAndSwap(
      {
        operationId: current.payload.operationId,
        revision: current.payload.revision,
        digest: current.digest,
      },
      next,
    )
  }

  const controlPlane: DatabaseMigrationControlPlane = {
    start(input) {
      const all = deps.store.list()
      const duplicate = all.find(
        (manifest) =>
          manifest.payload.source.generationId === input.sourceGenerationId &&
          manifest.payload.idempotencyKey === input.idempotencyKey,
      )
      if (duplicate !== undefined) return view(duplicate)

      const active = all.find(
        (manifest) =>
          manifest.payload.source.generationId === input.sourceGenerationId &&
          manifest.payload.phase !== 'finalized' &&
          manifest.payload.rolledBackAt === null &&
          manifest.payload.cancelledAt === null,
      )
      if (active !== undefined) {
        throw new DatabaseMigrationControlPlaneError(
          'database-migration-active',
          `database migration ${active.payload.operationId} is already active for source generation ${input.sourceGenerationId}`,
        )
      }
      return view(
        deps.store.create(
          createDatabaseMigrationManifest({
            operationId: newOperationId(),
            idempotencyKey: input.idempotencyKey,
            sourceGenerationId: input.sourceGenerationId,
            sourceSchemaDigest: input.sourceSchemaDigest,
            sourceDatabaseFingerprint: input.sourceDatabaseFingerprint,
            target: input.target,
            ownerId: newOwnerId(),
            ownerLeaseExpiresAt: input.now + input.ownerLeaseMs,
            tableCounts: input.tableCounts,
            now: input.now,
          }),
        ),
      )
    },

    get(operationId) {
      return view(readRequired(operationId))
    },

    list() {
      return deps.store.list().map(view)
    },

    advance(operationId, input) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          advanceDatabaseMigration(current, {
            ...input,
            expectedRevision: current.payload.revision,
          }),
        ),
      )
    },

    checkpoint(operationId, input) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          checkpointDatabaseMigration(current, {
            ...input,
            expectedRevision: current.payload.revision,
          }),
        ),
      )
    },

    fail(operationId, input) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          failDatabaseMigration(current, {
            ...input,
            expectedRevision: current.payload.revision,
          }),
        ),
      )
    },

    resume(operationId, input) {
      const current = readRequired(operationId)
      const requesterOwnerId = input.requesterOwnerId ?? newOwnerId()
      if (
        requesterOwnerId !== current.payload.owner.id &&
        input.now < current.payload.owner.leaseExpiresAt
      ) {
        throw new DatabaseMigrationControlPlaneError(
          'database-migration-lease-active',
          `database migration owner lease is active until ${current.payload.owner.leaseExpiresAt}`,
        )
      }
      return view(
        cas(
          current,
          resumeDatabaseMigration(current, {
            expectedRevision: current.payload.revision,
            previousOwnerId: current.payload.owner.id,
            previousOwnerFence: current.payload.owner.fence,
            nextOwnerId: requesterOwnerId,
            nextLeaseExpiresAt: input.now + input.ownerLeaseMs,
            now: input.now,
          }),
        ),
      )
    },

    requestCancel(operationId, now) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          requestDatabaseMigrationCancellation(current, {
            expectedRevision: current.payload.revision,
            ownerId: current.payload.owner.id,
            ownerFence: current.payload.owner.fence,
            now,
          }),
        ),
      )
    },

    settleCancelled(operationId, now) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          markDatabaseMigrationCancelled(current, {
            expectedRevision: current.payload.revision,
            ownerId: current.payload.owner.id,
            ownerFence: current.payload.owner.fence,
            now,
          }),
        ),
      )
    },

    markFirstLiveWrite(operationId, now) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          markDatabaseFirstLiveWrite(current, {
            expectedRevision: current.payload.revision,
            ownerId: current.payload.owner.id,
            ownerFence: current.payload.owner.fence,
            now,
          }),
        ),
      )
    },

    markRolledBack(operationId, receiptDigest, now) {
      const current = readRequired(operationId)
      return view(
        cas(
          current,
          markDatabaseMigrationRolledBack(current, {
            expectedRevision: current.payload.revision,
            ownerId: current.payload.owner.id,
            ownerFence: current.payload.owner.fence,
            receiptDigest,
            now,
          }),
        ),
      )
    },

    readManifest: readRequired,
  }
  return Object.freeze(controlPlane)
}
