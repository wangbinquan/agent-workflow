// RFC-349 — pure state machine for one durable SQLite -> PostgreSQL migration.
// The domain carries only non-secret identifiers/digests; connection URLs and
// user data are forbidden from the manifest by construction.

import { z } from 'zod'
import {
  databaseMigrationStartIdempotencyKeyWith,
  type DatabaseMigrationStartIdentity,
} from '@agent-workflow/shared'
import { canonicalSchemaJson, digestSchemaContract } from '@/platform/persistence/schemaContract'
import { sha256Hex } from '@/util/hash'

export const DATABASE_MIGRATION_PHASES = [
  'planned',
  'preflighted',
  'source-frozen',
  'backed-up',
  'target-prepared',
  'copying',
  'verifying',
  'cutover-prepared',
  'switched',
  'health-checked',
  'accepting-writes',
  'finalized',
] as const

export const DatabaseMigrationPhaseSchema = z.enum(DATABASE_MIGRATION_PHASES)
export type DatabaseMigrationPhase = z.infer<typeof DatabaseMigrationPhaseSchema>

const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const OperationIdSchema = z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)
const GenerationIdSchema = z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/)
const OwnerIdSchema = z.string().regex(/^dbo_[A-Za-z0-9_-]{8,128}$/)
const IdempotencyKeySchema = z.string().min(8).max(256)
const EnvNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)

export const DatabaseMigrationTargetConfigSchema = z
  .object({
    provider: z.literal('postgresql'),
    urlEnv: EnvNameSchema,
    poolMax: z.number().int().min(1).max(256),
    connectTimeoutMs: z.number().int().min(1_000).max(120_000),
    statementTimeoutMs: z.number().int().min(1_000).max(3_600_000),
    idleTimeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict()

export type DatabaseMigrationTargetConfig = z.infer<typeof DatabaseMigrationTargetConfigSchema>

/**
 * Authoritative operation identity. Adapters may send a request key, but the
 * control plane always re-derives this key from the live SQLite generation,
 * target profile and execution contract before it performs duplicate-start
 * admission.
 */
export function databaseMigrationOperationIdempotencyKey(
  input: DatabaseMigrationStartIdentity,
): string {
  return databaseMigrationStartIdempotencyKeyWith(
    databaseMigrationStartIdentitySchemaCompatible(input),
    sha256Hex,
  )
}

function databaseMigrationStartIdentitySchemaCompatible(
  input: DatabaseMigrationStartIdentity,
): DatabaseMigrationStartIdentity {
  return {
    source: { ...input.source },
    target: DatabaseMigrationTargetConfigSchema.parse(input.target),
    execution: { mode: 'automatic' },
  }
}

const DatabaseMigrationProgressSchema = z
  .object({
    table: z.string().nullable(),
    chunk: z.number().int().nonnegative(),
    tablesCompleted: z.number().int().nonnegative(),
    tablesTotal: z.number().int().nonnegative(),
    rowsCopied: z.number().int().nonnegative(),
    bytesCopied: z.number().int().nonnegative(),
    lastMigrationKey: z.array(z.string()),
  })
  .strict()

export type DatabaseMigrationProgress = z.infer<typeof DatabaseMigrationProgressSchema>

const DatabaseMigrationFailureSchema = z
  .object({
    phase: DatabaseMigrationPhaseSchema,
    category: z.enum([
      'target-unreachable',
      'target-permission',
      'source-integrity',
      'source-codec',
      'drain-timeout',
      'backup-failed',
      'target-schema',
      'copy-transient',
      'copy-permanent',
      'verification-mismatch',
      'cutover-failed',
      'health-failed',
      'manifest-corrupt',
      'owner-conflict',
      'cancelled',
      'internal',
    ]),
    detailCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
    retryable: z.boolean(),
    failedAt: z.number().int().nonnegative(),
    retryCount: z.number().int().nonnegative(),
    nextRetryAt: z.number().int().nonnegative().nullable(),
  })
  .strict()

export type DatabaseMigrationFailure = z.infer<typeof DatabaseMigrationFailureSchema>

const DatabaseMigrationCheckpointSchema = z
  .object({
    phase: DatabaseMigrationPhaseSchema,
    idempotencyKey: IdempotencyKeySchema,
    committedAt: z.number().int().nonnegative(),
    digest: DigestSchema,
  })
  .strict()

export const DatabaseMigrationManifestPayloadSchema = z
  .object({
    version: z.literal(2),
    revision: z.number().int().nonnegative(),
    previousDigest: DigestSchema.nullable(),
    operationId: OperationIdSchema,
    idempotencyKey: IdempotencyKeySchema,
    source: z
      .object({
        provider: z.literal('sqlite'),
        generationId: GenerationIdSchema,
        schemaDigest: DigestSchema,
        databaseFingerprint: z.string().min(1).max(256),
      })
      .strict(),
    target: DatabaseMigrationTargetConfigSchema.extend({
      databaseFingerprint: z.string().max(256).nullable(),
    }).strict(),
    tableCounts: z
      .object({
        source: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        archiveOnly: z.number().int().nonnegative(),
      })
      .strict()
      .refine((value) => value.source === value.active + value.archiveOnly, {
        message: 'source table count must equal active plus archive-only tables',
      }),
    phase: DatabaseMigrationPhaseSchema,
    lastIdempotencyKey: IdempotencyKeySchema,
    owner: z
      .object({
        id: OwnerIdSchema,
        fence: z.number().int().positive(),
        leaseExpiresAt: z.number().int().nonnegative(),
      })
      .strict(),
    progress: DatabaseMigrationProgressSchema,
    checkpoints: z.array(DatabaseMigrationCheckpointSchema),
    failure: DatabaseMigrationFailureSchema.nullable(),
    cancellationRequestedAt: z.number().int().nonnegative().nullable(),
    cancelledAt: z.number().int().nonnegative().nullable(),
    firstLiveWriteAt: z.number().int().nonnegative().nullable(),
    rolledBackAt: z.number().int().nonnegative().nullable(),
    rollbackReceiptDigest: DigestSchema.nullable(),
    sourceBackupDigest: DigestSchema.nullable(),
    logicalBackupDigest: DigestSchema.nullable(),
    legacyArchiveDigest: DigestSchema.nullable(),
    verificationDigest: DigestSchema.nullable(),
    receiptDigest: DigestSchema.nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.cancelledAt !== null && value.failure?.category !== 'cancelled') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cancelledAt'],
        message: 'cancelledAt requires a cancelled failure receipt',
      })
    }
    if (value.phase === 'finalized' && value.receiptDigest === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['receiptDigest'],
        message: 'finalized operation requires a receipt digest',
      })
    }
    if ((value.rolledBackAt === null) !== (value.rollbackReceiptDigest === null)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rollbackReceiptDigest'],
        message: 'rolledBackAt and rollbackReceiptDigest must be recorded together',
      })
    }
    if (value.rolledBackAt !== null && value.firstLiveWriteAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rolledBackAt'],
        message: 'instant rollback is forbidden after a PostgreSQL live write',
      })
    }
  })

export type DatabaseMigrationManifestPayload = z.infer<
  typeof DatabaseMigrationManifestPayloadSchema
>

export const DatabaseMigrationManifestSchema = z
  .object({
    payload: DatabaseMigrationManifestPayloadSchema,
    digest: DigestSchema,
  })
  .strict()

export type DatabaseMigrationManifest = z.infer<typeof DatabaseMigrationManifestSchema>

export function databaseMigrationManifestOperationIdempotencyKey(
  manifest: DatabaseMigrationManifest,
): string {
  return databaseMigrationOperationIdempotencyKey({
    source: {
      provider: 'sqlite',
      generationId: manifest.payload.source.generationId,
      schemaDigest: manifest.payload.source.schemaDigest,
      databaseFingerprint: manifest.payload.source.databaseFingerprint,
    },
    target: {
      provider: 'postgresql',
      urlEnv: manifest.payload.target.urlEnv,
      poolMax: manifest.payload.target.poolMax,
      connectTimeoutMs: manifest.payload.target.connectTimeoutMs,
      statementTimeoutMs: manifest.payload.target.statementTimeoutMs,
      idleTimeoutMs: manifest.payload.target.idleTimeoutMs,
    },
    execution: { mode: 'automatic' },
  })
}

export class DatabaseMigrationStateError extends Error {
  constructor(
    public readonly code:
      | 'migration-invalid-transition'
      | 'migration-stale-revision'
      | 'migration-owner-fence'
      | 'migration-failed'
      | 'migration-cancel-not-allowed'
      | 'migration-finalize-not-allowed'
      | 'migration-rollback-not-allowed'
      | 'migration-live-write-already-marked',
    message: string,
  ) {
    super(message)
    this.name = 'DatabaseMigrationStateError'
  }
}

const NEXT_PHASE: Readonly<Record<DatabaseMigrationPhase, DatabaseMigrationPhase | null>> = {
  planned: 'preflighted',
  preflighted: 'source-frozen',
  'source-frozen': 'backed-up',
  'backed-up': 'target-prepared',
  'target-prepared': 'copying',
  copying: 'verifying',
  verifying: 'cutover-prepared',
  'cutover-prepared': 'switched',
  switched: 'health-checked',
  'health-checked': 'accepting-writes',
  'accepting-writes': 'finalized',
  finalized: null,
}

const CANCELABLE_PHASES = new Set<DatabaseMigrationPhase>([
  'planned',
  'preflighted',
  'source-frozen',
  'backed-up',
  'target-prepared',
  'copying',
  'verifying',
])

function withDigest(payload: DatabaseMigrationManifestPayload): DatabaseMigrationManifest {
  const parsed = DatabaseMigrationManifestPayloadSchema.parse(payload)
  return { payload: parsed, digest: digestSchemaContract(parsed) }
}

export function verifyDatabaseMigrationManifest(value: unknown): DatabaseMigrationManifest {
  const parsed = DatabaseMigrationManifestSchema.parse(value)
  const actual = digestSchemaContract(parsed.payload)
  if (actual !== parsed.digest) {
    throw new Error(`database migration manifest digest mismatch for ${parsed.payload.operationId}`)
  }
  return parsed
}

export interface CreateDatabaseMigrationManifestInput {
  readonly operationId: string
  readonly idempotencyKey: string
  readonly sourceGenerationId: string
  readonly sourceSchemaDigest: string
  readonly sourceDatabaseFingerprint: string
  readonly target: DatabaseMigrationTargetConfig
  readonly ownerId: string
  readonly ownerLeaseExpiresAt: number
  readonly tableCounts: {
    readonly source: number
    readonly active: number
    readonly archiveOnly: number
  }
  readonly now: number
}

export function createDatabaseMigrationManifest(
  input: CreateDatabaseMigrationManifestInput,
): DatabaseMigrationManifest {
  const payload: DatabaseMigrationManifestPayload = {
    version: 2,
    revision: 0,
    previousDigest: null,
    operationId: input.operationId,
    idempotencyKey: input.idempotencyKey,
    source: {
      provider: 'sqlite',
      generationId: input.sourceGenerationId,
      schemaDigest: input.sourceSchemaDigest,
      databaseFingerprint: input.sourceDatabaseFingerprint,
    },
    target: { ...input.target, databaseFingerprint: null },
    tableCounts: input.tableCounts,
    phase: 'planned',
    lastIdempotencyKey: input.idempotencyKey,
    owner: { id: input.ownerId, fence: 1, leaseExpiresAt: input.ownerLeaseExpiresAt },
    progress: {
      table: null,
      chunk: 0,
      tablesCompleted: 0,
      tablesTotal: input.tableCounts.source,
      rowsCopied: 0,
      bytesCopied: 0,
      lastMigrationKey: [],
    },
    checkpoints: [],
    failure: null,
    cancellationRequestedAt: null,
    cancelledAt: null,
    firstLiveWriteAt: null,
    rolledBackAt: null,
    rollbackReceiptDigest: null,
    sourceBackupDigest: null,
    logicalBackupDigest: null,
    legacyArchiveDigest: null,
    verificationDigest: null,
    receiptDigest: null,
    createdAt: input.now,
    updatedAt: input.now,
  }
  return withDigest(payload)
}

function assertMutationAuthority(
  current: DatabaseMigrationManifest,
  input: {
    readonly expectedRevision: number
    readonly ownerId: string
    readonly ownerFence: number
  },
): void {
  if (current.payload.revision !== input.expectedRevision) {
    throw new DatabaseMigrationStateError(
      'migration-stale-revision',
      `database migration revision is ${current.payload.revision}, expected ${input.expectedRevision}`,
    )
  }
  if (
    current.payload.owner.id !== input.ownerId ||
    current.payload.owner.fence !== input.ownerFence
  ) {
    throw new DatabaseMigrationStateError(
      'migration-owner-fence',
      'database migration owner fence is stale',
    )
  }
}

export interface AdvanceDatabaseMigrationInput {
  readonly expectedRevision: number
  readonly expectedPhase: DatabaseMigrationPhase
  readonly nextPhase: DatabaseMigrationPhase
  readonly ownerId: string
  readonly ownerFence: number
  readonly idempotencyKey: string
  readonly now: number
  readonly progress?: Partial<DatabaseMigrationProgress>
  readonly targetDatabaseFingerprint?: string
  readonly sourceBackupDigest?: string
  readonly logicalBackupDigest?: string
  readonly legacyArchiveDigest?: string
  readonly verificationDigest?: string
  readonly receiptDigest?: string
}

export interface CheckpointDatabaseMigrationInput {
  readonly expectedRevision: number
  readonly expectedPhase: DatabaseMigrationPhase
  readonly ownerId: string
  readonly ownerFence: number
  readonly idempotencyKey: string
  readonly now: number
  readonly ownerLeaseExpiresAt: number
  readonly progress: DatabaseMigrationProgress
}

export function checkpointDatabaseMigration(
  current: DatabaseMigrationManifest,
  input: CheckpointDatabaseMigrationInput,
): DatabaseMigrationManifest {
  if (
    current.payload.phase === input.expectedPhase &&
    current.payload.lastIdempotencyKey === input.idempotencyKey
  ) {
    return current
  }
  assertMutationAuthority(current, input)
  if (current.payload.failure !== null) {
    throw new DatabaseMigrationStateError(
      'migration-failed',
      'database migration must be resumed before checkpointing',
    )
  }
  if (current.payload.rolledBackAt !== null) {
    throw new DatabaseMigrationStateError(
      'migration-rollback-not-allowed',
      'a rolled-back database migration cannot advance',
    )
  }
  if (current.payload.phase !== input.expectedPhase) {
    throw new DatabaseMigrationStateError(
      'migration-invalid-transition',
      `database migration cannot checkpoint ${input.expectedPhase} while in ${current.payload.phase}`,
    )
  }
  const revision = current.payload.revision + 1
  const checkpoint = {
    phase: current.payload.phase,
    idempotencyKey: input.idempotencyKey,
    committedAt: input.now,
    digest: digestSchemaContract({
      operationId: current.payload.operationId,
      revision,
      phase: current.payload.phase,
      idempotencyKey: input.idempotencyKey,
      progress: input.progress,
      committedAt: input.now,
    }),
  }
  return withDigest({
    ...current.payload,
    revision,
    previousDigest: current.digest,
    lastIdempotencyKey: input.idempotencyKey,
    owner: { ...current.payload.owner, leaseExpiresAt: input.ownerLeaseExpiresAt },
    progress: input.progress,
    checkpoints: [...current.payload.checkpoints, checkpoint],
    updatedAt: input.now,
  })
}

export function advanceDatabaseMigration(
  current: DatabaseMigrationManifest,
  input: AdvanceDatabaseMigrationInput,
): DatabaseMigrationManifest {
  if (
    current.payload.phase === input.nextPhase &&
    current.payload.lastIdempotencyKey === input.idempotencyKey
  ) {
    return current
  }
  assertMutationAuthority(current, input)
  if (current.payload.failure !== null) {
    throw new DatabaseMigrationStateError(
      'migration-failed',
      'database migration must be resumed before advancing',
    )
  }
  if (current.payload.rolledBackAt !== null) {
    throw new DatabaseMigrationStateError(
      'migration-rollback-not-allowed',
      'a rolled-back database migration cannot advance',
    )
  }
  if (
    current.payload.phase !== input.expectedPhase ||
    NEXT_PHASE[current.payload.phase] !== input.nextPhase
  ) {
    throw new DatabaseMigrationStateError(
      'migration-invalid-transition',
      `database migration cannot transition ${current.payload.phase} -> ${input.nextPhase}`,
    )
  }

  const checkpointPayload = {
    operationId: current.payload.operationId,
    revision: current.payload.revision + 1,
    phase: input.nextPhase,
    idempotencyKey: input.idempotencyKey,
    progress: { ...current.payload.progress, ...input.progress },
    committedAt: input.now,
  }
  const checkpoint = {
    phase: input.nextPhase,
    idempotencyKey: input.idempotencyKey,
    committedAt: input.now,
    digest: digestSchemaContract(checkpointPayload),
  }
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    phase: input.nextPhase,
    lastIdempotencyKey: input.idempotencyKey,
    target: {
      ...current.payload.target,
      ...(input.targetDatabaseFingerprint === undefined
        ? {}
        : { databaseFingerprint: input.targetDatabaseFingerprint }),
    },
    progress: { ...current.payload.progress, ...input.progress },
    checkpoints: [...current.payload.checkpoints, checkpoint],
    sourceBackupDigest: input.sourceBackupDigest ?? current.payload.sourceBackupDigest,
    logicalBackupDigest: input.logicalBackupDigest ?? current.payload.logicalBackupDigest,
    legacyArchiveDigest: input.legacyArchiveDigest ?? current.payload.legacyArchiveDigest,
    verificationDigest: input.verificationDigest ?? current.payload.verificationDigest,
    receiptDigest: input.receiptDigest ?? current.payload.receiptDigest,
    updatedAt: input.now,
  })
}

export interface FailDatabaseMigrationInput {
  readonly expectedRevision: number
  readonly ownerId: string
  readonly ownerFence: number
  readonly category: DatabaseMigrationFailure['category']
  readonly detailCode: string
  readonly retryable: boolean
  readonly retryCount: number
  readonly nextRetryAt: number | null
  readonly now: number
}

export function failDatabaseMigration(
  current: DatabaseMigrationManifest,
  input: FailDatabaseMigrationInput,
): DatabaseMigrationManifest {
  assertMutationAuthority(current, input)
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    failure: {
      phase: current.payload.phase,
      category: input.category,
      detailCode: input.detailCode,
      retryable: input.retryable,
      failedAt: input.now,
      retryCount: input.retryCount,
      nextRetryAt: input.nextRetryAt,
    },
    updatedAt: input.now,
  })
}

export function resumeDatabaseMigration(
  current: DatabaseMigrationManifest,
  input: {
    readonly expectedRevision: number
    readonly previousOwnerId: string
    readonly previousOwnerFence: number
    readonly nextOwnerId: string
    readonly nextLeaseExpiresAt: number
    readonly now: number
  },
): DatabaseMigrationManifest {
  assertMutationAuthority(current, {
    expectedRevision: input.expectedRevision,
    ownerId: input.previousOwnerId,
    ownerFence: input.previousOwnerFence,
  })
  if (current.payload.rolledBackAt !== null) {
    throw new DatabaseMigrationStateError(
      'migration-rollback-not-allowed',
      'a rolled-back database migration cannot resume',
    )
  }
  if (current.payload.failure !== null && !current.payload.failure.retryable) {
    throw new DatabaseMigrationStateError(
      'migration-failed',
      'database migration failure is not retryable',
    )
  }
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    owner: {
      id: input.nextOwnerId,
      fence: current.payload.owner.fence + 1,
      leaseExpiresAt: input.nextLeaseExpiresAt,
    },
    failure: null,
    cancellationRequestedAt: null,
    cancelledAt: null,
    updatedAt: input.now,
  })
}

export function requestDatabaseMigrationCancellation(
  current: DatabaseMigrationManifest,
  input: {
    readonly expectedRevision: number
    readonly ownerId: string
    readonly ownerFence: number
    readonly now: number
  },
): DatabaseMigrationManifest {
  assertMutationAuthority(current, input)
  if (!CANCELABLE_PHASES.has(current.payload.phase)) {
    throw new DatabaseMigrationStateError(
      'migration-cancel-not-allowed',
      `database migration cannot cancel during ${current.payload.phase}`,
    )
  }
  if (current.payload.cancellationRequestedAt !== null) return current
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    cancellationRequestedAt: input.now,
    updatedAt: input.now,
  })
}

export function markDatabaseMigrationCancelled(
  current: DatabaseMigrationManifest,
  input: {
    readonly expectedRevision: number
    readonly ownerId: string
    readonly ownerFence: number
    readonly now: number
  },
): DatabaseMigrationManifest {
  assertMutationAuthority(current, input)
  if (current.payload.cancellationRequestedAt === null) {
    throw new DatabaseMigrationStateError(
      'migration-cancel-not-allowed',
      'database migration cancellation was not requested',
    )
  }
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    failure: {
      phase: current.payload.phase,
      category: 'cancelled',
      detailCode: 'operator-cancelled-at-checkpoint',
      retryable: true,
      failedAt: input.now,
      retryCount: 0,
      nextRetryAt: null,
    },
    cancelledAt: input.now,
    updatedAt: input.now,
  })
}

export function markDatabaseFirstLiveWrite(
  current: DatabaseMigrationManifest,
  input: {
    readonly expectedRevision: number
    readonly ownerId: string
    readonly ownerFence: number
    readonly now: number
  },
): DatabaseMigrationManifest {
  assertMutationAuthority(current, input)
  if (current.payload.rolledBackAt !== null) {
    throw new DatabaseMigrationStateError(
      'migration-rollback-not-allowed',
      'a rolled-back generation cannot record a live write',
    )
  }
  if (
    current.payload.phase !== 'switched' &&
    current.payload.phase !== 'health-checked' &&
    current.payload.phase !== 'accepting-writes'
  ) {
    throw new DatabaseMigrationStateError(
      'migration-invalid-transition',
      'first live write marker requires a switched PostgreSQL generation',
    )
  }
  if (current.payload.firstLiveWriteAt !== null) return current
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    firstLiveWriteAt: input.now,
    updatedAt: input.now,
  })
}

export function markDatabaseMigrationRolledBack(
  current: DatabaseMigrationManifest,
  input: {
    readonly expectedRevision: number
    readonly ownerId: string
    readonly ownerFence: number
    readonly receiptDigest: string
    readonly now: number
  },
): DatabaseMigrationManifest {
  assertMutationAuthority(current, input)
  if (current.payload.rolledBackAt !== null) return current
  if (
    !['switched', 'health-checked', 'accepting-writes'].includes(current.payload.phase) ||
    current.payload.firstLiveWriteAt !== null
  ) {
    throw new DatabaseMigrationStateError(
      'migration-rollback-not-allowed',
      'instant rollback requires a switched generation with no PostgreSQL live write',
    )
  }
  return withDigest({
    ...current.payload,
    revision: current.payload.revision + 1,
    previousDigest: current.digest,
    rolledBackAt: input.now,
    rollbackReceiptDigest: input.receiptDigest,
    updatedAt: input.now,
  })
}

export type DatabaseRollbackEligibility =
  | { readonly eligible: true; readonly reason: 'target-has-no-live-write' }
  | {
      readonly eligible: false
      readonly reason:
        | 'pointer-not-switched'
        | 'cutover-in-progress'
        | 'reverse-migration-required'
        | 'operation-finalized'
        | 'operation-rolled-back'
    }

export function databaseRollbackEligibility(
  manifest: DatabaseMigrationManifest,
): DatabaseRollbackEligibility {
  const phase = manifest.payload.phase
  if (manifest.payload.rolledBackAt !== null) {
    return { eligible: false, reason: 'operation-rolled-back' }
  }
  if (
    phase === 'planned' ||
    phase === 'preflighted' ||
    phase === 'source-frozen' ||
    phase === 'backed-up' ||
    phase === 'target-prepared' ||
    phase === 'copying' ||
    phase === 'verifying'
  ) {
    return { eligible: false, reason: 'pointer-not-switched' }
  }
  if (phase === 'cutover-prepared') return { eligible: false, reason: 'cutover-in-progress' }
  if (phase === 'finalized') return { eligible: false, reason: 'operation-finalized' }
  if (manifest.payload.firstLiveWriteAt !== null) {
    return { eligible: false, reason: 'reverse-migration-required' }
  }
  return { eligible: true, reason: 'target-has-no-live-write' }
}

export function serializeDatabaseMigrationManifest(manifest: DatabaseMigrationManifest): string {
  return canonicalSchemaJson(verifyDatabaseMigrationManifest(manifest))
}
