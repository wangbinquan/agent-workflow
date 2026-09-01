// RFC-349 — transport-neutral one-click SQLite -> PostgreSQL migration DTOs.
// Connection URLs never cross this shared surface; only the environment
// variable name and bounded non-secret pool settings are observable.

import { z } from 'zod'
import { canonicalJson } from '../workflow-canonical'

export const DATABASE_MIGRATION_START_IDENTITY_DOMAIN_V1 = 'database-migration-start-identity/v1\n'

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

export const databaseMigrationSourceIdentitySchema = z
  .object({
    provider: z.literal('sqlite'),
    generationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    databaseFingerprint: z.string().min(1).max(256),
  })
  .strict()
export type DatabaseMigrationSourceIdentity = z.infer<typeof databaseMigrationSourceIdentitySchema>

export const databaseMigrationExecutionOptionsSchema = z
  .object({ mode: z.literal('automatic') })
  .strict()
export type DatabaseMigrationExecutionOptions = z.infer<
  typeof databaseMigrationExecutionOptionsSchema
>

export const databaseMigrationStartIdentitySchema = z
  .object({
    source: databaseMigrationSourceIdentitySchema,
    target: databaseMigrationTargetSchema,
    execution: databaseMigrationExecutionOptionsSchema,
  })
  .strict()
export type DatabaseMigrationStartIdentity = z.infer<typeof databaseMigrationStartIdentitySchema>

/**
 * Domain-separated, surface-neutral projection for one migration operation.
 * Settings and CLI must hash these exact bytes instead of adding an adapter
 * prefix. The source identity prevents a later SQLite generation at the same
 * path from inheriting an earlier operation.
 */
export function serializeDatabaseMigrationStartIdentityV1(
  input: DatabaseMigrationStartIdentity,
): string {
  return `${DATABASE_MIGRATION_START_IDENTITY_DOMAIN_V1}${canonicalJson(
    databaseMigrationStartIdentitySchema.parse(input),
  )}`
}

export function databaseMigrationStartIdempotencyKeyFromHash(hash: string): string {
  const normalized = hash.toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error('database migration identity hash must be a lowercase SHA-256 hex digest')
  }
  return `database-migration:v1:${normalized}`
}

export function databaseMigrationStartIdempotencyKeyWith(
  input: DatabaseMigrationStartIdentity,
  sha256Hex: (canonical: string) => string,
): string {
  return databaseMigrationStartIdempotencyKeyFromHash(
    sha256Hex(serializeDatabaseMigrationStartIdentityV1(input)),
  )
}

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
export type DatabaseMigrationPreflightInput = z.infer<typeof databaseMigrationPreflightInputSchema>

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
export type DatabaseMigrationPreflightView = z.infer<typeof databaseMigrationPreflightViewSchema>

export const databaseRuntimeOverviewSchema = z
  .object({
    provider: z.enum(['sqlite', 'postgresql']),
    generationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    databaseFingerprint: z.string().min(1).max(256).nullable(),
    serverVersion: z.string().min(1).max(256).nullable(),
    operationId: z
      .string()
      .regex(/^dbm_[A-Za-z0-9_-]{8,128}$/)
      .nullable(),
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

export function databaseMigrationStartIdentityFromOverview(
  overview: DatabaseRuntimeOverview,
  target: DatabaseMigrationTargetView,
): DatabaseMigrationStartIdentity | null {
  if (
    overview.provider !== 'sqlite' ||
    overview.databaseFingerprint === null ||
    overview.source === null ||
    overview.source.databaseFingerprint !== overview.databaseFingerprint
  ) {
    return null
  }
  return databaseMigrationStartIdentitySchema.parse({
    source: {
      provider: 'sqlite',
      generationId: overview.generationId,
      schemaDigest: overview.schemaDigest,
      databaseFingerprint: overview.databaseFingerprint,
    },
    target,
    execution: { mode: 'automatic' },
  })
}

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
export type DatabaseMigrationOperationInput = z.infer<typeof databaseMigrationOperationInputSchema>

export const databaseMigrationArtifactKindSchema = z.enum([
  'logical-backup',
  'legacy-archive',
  'verification',
  'receipt',
  'rollback-receipt',
])
export type DatabaseMigrationArtifactKind = z.infer<typeof databaseMigrationArtifactKindSchema>

export const databaseMigrationArtifactInputSchema = databaseMigrationOperationInputSchema
  .extend({ kind: databaseMigrationArtifactKindSchema })
  .strict()
export type DatabaseMigrationArtifactInput = z.infer<typeof databaseMigrationArtifactInputSchema>

const databaseMigrationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/)

/**
 * A verified JSON artifact. `digest` is the durable operation/content anchor;
 * `fileDigest` covers the exact UTF-8 bytes returned in `json`.
 */
export const databaseMigrationArtifactViewSchema = z
  .object({
    operationId: z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/),
    kind: z.enum([
      'logical-backup',
      'legacy-archive',
      'legacy-archive-chunk',
      'verification',
      'receipt',
      'rollback-receipt',
    ]),
    fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.json$/),
    contentType: z.literal('application/json; charset=utf-8'),
    byteLength: z.number().int().nonnegative(),
    digest: databaseMigrationDigestSchema,
    fileDigest: databaseMigrationDigestSchema,
    json: z.string(),
  })
  .strict()
export type DatabaseMigrationArtifactView = z.infer<typeof databaseMigrationArtifactViewSchema>

export const databaseMigrationLegacyTableInputSchema = databaseMigrationOperationInputSchema
  .extend({ table: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/) })
  .strict()
export type DatabaseMigrationLegacyTableInput = z.infer<
  typeof databaseMigrationLegacyTableInputSchema
>

export const databaseMigrationLegacyTableViewSchema = z
  .object({
    operationId: z.string().regex(/^dbm_[A-Za-z0-9_-]{8,128}$/),
    table: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
    disposition: z.literal('ARCHIVE_THEN_OMIT'),
    rowCount: z.number().int().nonnegative(),
    chunkCount: z.number().int().nonnegative(),
    firstKey: z.array(z.string()).nullable(),
    lastKey: z.array(z.string()).nullable(),
    rootDigest: databaseMigrationDigestSchema,
    blobBytes: z.number().int().nonnegative(),
  })
  .strict()
export type DatabaseMigrationLegacyTableView = z.infer<
  typeof databaseMigrationLegacyTableViewSchema
>

export const databaseMigrationLegacyChunkInputSchema = databaseMigrationLegacyTableInputSchema
  .extend({ chunkIndex: z.number().int().nonnegative() })
  .strict()
export type DatabaseMigrationLegacyChunkInput = z.infer<
  typeof databaseMigrationLegacyChunkInputSchema
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
