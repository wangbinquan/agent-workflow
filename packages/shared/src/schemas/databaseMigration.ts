// RFC-349 — transport-neutral one-click SQLite -> PostgreSQL migration DTOs.
// Connection URLs never cross this shared surface; only the environment
// variable name and bounded non-secret pool settings are observable.

import { z } from 'zod'

export const databaseMigrationTargetSchema = z
  .object({
    provider: z.literal('postgresql'),
    urlEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    poolMax: z.number().int().min(1).max(256),
    connectTimeoutMs: z.number().int().min(1_000).max(120_000),
    statementTimeoutMs: z.number().int().min(1_000).max(3_600_000),
    idleTimeoutMs: z.number().int().min(1_000).max(600_000),
  })
  .strict()
export type DatabaseMigrationTargetView = z.infer<typeof databaseMigrationTargetSchema>

export const databaseMigrationTableCountsSchema = z
  .object({
    source: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    archiveOnly: z.number().int().nonnegative(),
  })
  .strict()

export const databaseMigrationPreflightInputSchema = z
  .object({ target: databaseMigrationTargetSchema })
  .strict()
export type DatabaseMigrationPreflightInput = z.infer<
  typeof databaseMigrationPreflightInputSchema
>

export const databaseMigrationPreflightViewSchema = z
  .object({
    ok: z.literal(true),
    databaseFingerprint: z.string().min(1).max(256),
    serverMajor: z.number().int().min(15).max(18),
    serverVersionNum: z.number().int().positive(),
    serverEncoding: z.literal('UTF8'),
    timezone: z.literal('UTC'),
    databaseBytes: z.number().int().nonnegative(),
    targetState: z.enum(['empty', 'resumable']),
    applicationTableCount: z.number().int().nonnegative(),
    metadataTableCount: z.number().int().nonnegative(),
    sourceDatabaseFingerprint: z.string().min(1).max(256),
    sourceBytes: z.number().int().nonnegative(),
    sourceRows: z.number().int().nonnegative(),
    tableCounts: databaseMigrationTableCountsSchema,
  })
  .strict()
export type DatabaseMigrationPreflightView = z.infer<
  typeof databaseMigrationPreflightViewSchema
>

export const databaseRuntimeOverviewSchema = z
  .object({
    provider: z.enum(['sqlite', 'postgresql']),
    generationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    databaseFingerprint: z.string().min(1).max(256).nullable(),
    serverVersion: z.string().min(1).max(256).nullable(),
    operationId: z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/).nullable(),
    target: databaseMigrationTargetSchema.nullable(),
    source: z
      .object({
        databaseFingerprint: z.string().min(1).max(256),
        fileBytes: z.number().int().nonnegative(),
        totalRows: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    tableCounts: databaseMigrationTableCountsSchema,
  })
  .strict()
export type DatabaseRuntimeOverview = z.infer<typeof databaseRuntimeOverviewSchema>

export const startDatabaseMigrationInputSchema = z
  .object({
    idempotencyKey: z.string().min(8).max(256),
    target: databaseMigrationTargetSchema,
  })
  .strict()
export type StartDatabaseMigrationInput = z.infer<typeof startDatabaseMigrationInputSchema>

export const databaseMigrationOperationInputSchema = z
  .object({ operationId: z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/) })
  .strict()
export type DatabaseMigrationOperationInput = z.infer<
  typeof databaseMigrationOperationInputSchema
>

export const databaseMigrationStatusViewSchema = z
  .object({
    operationId: z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/),
    revision: z.number().int().nonnegative(),
    phase: z.enum([
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
    ]),
    sourceGenerationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    targetProvider: z.literal('postgresql'),
    targetUrlEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    target: databaseMigrationTargetSchema,
    targetDatabaseFingerprint: z.string().max(256).nullable(),
    tableCounts: databaseMigrationTableCountsSchema,
    progress: z
      .object({
        table: z.string().nullable(),
        chunk: z.number().int().nonnegative(),
        tablesCompleted: z.number().int().nonnegative(),
        tablesTotal: z.number().int().nonnegative(),
        rowsCopied: z.number().int().nonnegative(),
        bytesCopied: z.number().int().nonnegative(),
        lastMigrationKey: z.array(z.string()),
      })
      .strict(),
    failure: z
      .object({
        phase: z.string(),
        category: z.string(),
        detailCode: z.string(),
        retryable: z.boolean(),
        failedAt: z.number().int().nonnegative(),
        retryCount: z.number().int().nonnegative(),
        nextRetryAt: z.number().int().nonnegative().nullable(),
      })
      .strict()
      .nullable(),
    cancelEligible: z.boolean(),
    resumeEligible: z.boolean(),
    rollback: z
      .object({
        eligible: z.boolean(),
        reason: z.enum([
          'target-has-no-live-write',
          'pointer-not-switched',
          'cutover-in-progress',
          'reverse-migration-required',
          'operation-finalized',
          'operation-rolled-back',
        ]),
      })
      .strict(),
    firstLiveWriteAt: z.number().int().nonnegative().nullable(),
    rolledBackAt: z.number().int().nonnegative().nullable(),
    rollbackReceiptDigest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict()
export type DatabaseMigrationStatusView = z.infer<typeof databaseMigrationStatusViewSchema>

export const databaseMigrationListViewSchema = z
  .object({ operations: z.array(databaseMigrationStatusViewSchema) })
  .strict()
export type DatabaseMigrationListView = z.infer<typeof databaseMigrationListViewSchema>
