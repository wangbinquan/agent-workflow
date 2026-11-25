// RFC-550 (RFC-294 S9): the runtime contracts of the backup / restore DTOs. They sat on `public/types` without any other
// module reading them; the DTO types inferred from them stay public, except the two only this module consumes
// (`CancelStagedRestoreResult`, `RecoveryStatusView`), which RFC-576 infers here.
import { z } from 'zod'

const restoredComponentsSchema = z
  .object({ db: z.boolean(), config: z.boolean(), skills: z.boolean() })
  .strict()

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

export const requestBackupInputSchema = z.object({ includeWorktrees: z.boolean() }).strict()

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

export const restorePlanOptionsSchema = z.object({ skipIntegrityCheck: z.boolean() }).strict()

export const restorePlanViewSchema = z
  .object({
    backupKind: z.string().nullable(),
    backupMigrationCreatedAt: z.number().nullable(),
    binaryMigrationCreatedAt: z.number(),
    direction: z.enum(['same', 'forward', 'downgrade']),
  })
  .strict()

export const stageRestoreOptionsSchema = z
  .object({
    noSafetyBackup: z.boolean(),
    noMigrate: z.boolean(),
    skipIntegrityCheck: z.boolean(),
  })
  .strict()

export const stageRestoreResultSchema = z
  .object({ direction: z.enum(['same', 'forward', 'downgrade']) })
  .strict()

export const cancelStagedRestoreResultSchema = z.object({ cleared: z.boolean() }).strict()
/** RFC-576: inferred here, not on `public/types` — only this module's operations and HTTP bindings use it. */
export type CancelStagedRestoreResult = z.infer<typeof cancelStagedRestoreResultSchema>

export const activateLocalRestoreOptionsSchema = z
  .object({
    noSafetyBackup: z.boolean(),
    noMigrate: z.boolean(),
    skipIntegrityCheck: z.boolean(),
  })
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

export const recoveryStatusViewSchema = z
  .object({
    pending: pendingRestoreViewSchema.nullable(),
    failed: z.array(failedRestoreViewSchema),
  })
  .strict()
/** RFC-576: inferred here, not on `public/types` — only this module's operations and HTTP bindings use it. */
export type RecoveryStatusView = z.infer<typeof recoveryStatusViewSchema>
