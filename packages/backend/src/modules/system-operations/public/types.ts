// RFC-346 — exact application DTOs for backup/restore administration.

import { z } from 'zod'

// RFC-349 — the system-operations public contract is shared byte-for-byte with
// Settings. Keep provider clients and raw connection URLs outside this surface.
export {
  type DatabaseMigrationArtifactInput,
  type DatabaseMigrationArtifactKind,
  type DatabaseMigrationArtifactView,
  type DatabaseMigrationLegacyChunkInput,
  type DatabaseMigrationLegacyTableInput,
  type DatabaseMigrationLegacyTableView,
  type DatabaseMigrationListView,
  type DatabaseMigrationOperationInput,
  type DatabaseMigrationPreflightInput,
  type DatabaseMigrationPreflightView,
  type DatabaseMigrationStatusView,
  type DatabaseMigrationTargetView,
  type DatabaseRuntimeOverview,
  type StartDatabaseMigrationInput,
} from '@agent-workflow/shared'

// Authority-bearing contexts stay on executable commands/queries. This file
// remains DTO/ref-only so request authority cannot leak through public types.
declare const localSystemOperationContextBrand: unique symbol
declare const restoreArtifactRefBrand: unique symbol

export interface LocalSystemOperationContext {
  readonly [localSystemOperationContextBrand]: 'local-system-operation-context'
}

export interface RestoreArtifactRef {
  readonly [restoreArtifactRefBrand]: 'restore-artifact-ref'
}

export const requestBackupInputSchema = z.object({ includeWorktrees: z.boolean() }).strict()
export type RequestBackupInput = z.infer<typeof requestBackupInputSchema>

export const backupResultViewSchema = z
  .object({
    path: z.string(),
    sizeBytes: z.number().nonnegative(),
    contents: z
      .object({
        workflows: z.number().int().nonnegative(),
        skills: z.number().int().nonnegative(),
        db: z.boolean(),
        config: z.boolean(),
      })
      .strict(),
  })
  .strict()
export type BackupResultView = z.infer<typeof backupResultViewSchema>

export const restorePlanOptionsSchema = z.object({ skipIntegrityCheck: z.boolean() }).strict()
export type RestorePlanOptions = z.infer<typeof restorePlanOptionsSchema>

export interface PlanLocalRestoreInput extends RestorePlanOptions {
  readonly artifactRef: RestoreArtifactRef
}

export const restorePlanViewSchema = z
  .object({
    backupKind: z.string().nullable(),
    backupMigrationCreatedAt: z.number().nullable(),
    binaryMigrationCreatedAt: z.number(),
    direction: z.enum(['same', 'forward', 'downgrade']),
  })
  .strict()
export type RestorePlanView = z.infer<typeof restorePlanViewSchema>

export const stageRestoreOptionsSchema = z
  .object({
    noSafetyBackup: z.boolean(),
    noMigrate: z.boolean(),
    skipIntegrityCheck: z.boolean(),
  })
  .strict()
export type StageRestoreOptions = z.infer<typeof stageRestoreOptionsSchema>

export interface StageRestoreInput extends StageRestoreOptions {
  readonly artifactRef: RestoreArtifactRef
}

export const stageRestoreResultSchema = z
  .object({ direction: z.enum(['same', 'forward', 'downgrade']) })
  .strict()
export type StageRestoreResult = z.infer<typeof stageRestoreResultSchema>

export const cancelStagedRestoreResultSchema = z.object({ cleared: z.boolean() }).strict()
export type CancelStagedRestoreResult = z.infer<typeof cancelStagedRestoreResultSchema>

export const activateLocalRestoreOptionsSchema = z
  .object({
    noSafetyBackup: z.boolean(),
    noMigrate: z.boolean(),
    skipIntegrityCheck: z.boolean(),
  })
  .strict()
export type ActivateLocalRestoreOptions = z.infer<typeof activateLocalRestoreOptionsSchema>

export interface ActivateLocalRestoreInput extends ActivateLocalRestoreOptions {
  readonly artifactRef: RestoreArtifactRef
}

const restoredComponentsSchema = z
  .object({ db: z.boolean(), config: z.boolean(), skills: z.boolean() })
  .strict()

export const localRestoreActivationSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('completed'),
      direction: z.enum(['same', 'forward', 'downgrade']),
      safetyBackupPath: z.string().nullable(),
      migrated: z.boolean(),
      restored: restoredComponentsSchema,
    })
    .strict(),
  z.object({ status: z.literal('daemon-running'), pid: z.number().int().positive() }).strict(),
  z.object({ status: z.literal('lock-unavailable') }).strict(),
])
export type LocalRestoreActivationResult = z.infer<typeof localRestoreActivationSchema>

const pendingRestoreViewSchema = z
  .object({
    requestedAt: z.number(),
    stagedBytes: z.number().nonnegative().nullable(),
    noMigrate: z.boolean(),
    skipIntegrityCheck: z.boolean(),
  })
  .strict()

const failedRestoreViewSchema = z
  .object({
    dir: z.string(),
    failedAt: z.number().nullable(),
    error: z.string().nullable(),
  })
  .strict()

export const recoveryStatusViewSchema = z
  .object({
    pending: pendingRestoreViewSchema.nullable(),
    failed: z.array(failedRestoreViewSchema),
  })
  .strict()
export type RecoveryStatusView = z.infer<typeof recoveryStatusViewSchema>
