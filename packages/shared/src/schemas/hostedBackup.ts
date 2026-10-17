import { z } from 'zod'

// RFC-370 v3 V5: a hosted backup is one database archive in CrewStation object
// storage. Task workspaces are not part of it (they live on platform volumes).
export const HostedBackupEntrySchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['manual', 'scheduled']),
    state: z.enum(['building', 'ready', 'failed', 'released']),
    createdAt: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative().nullable(),
    protected: z.boolean(),
  })
  .strict()
export const HostedBackupCatalogSchema = z
  .object({
    backups: z.array(HostedBackupEntrySchema).max(100),
    hasMore: z.boolean(),
  })
  .strict()
/** Catalog facts plus a platform check that the archive object still exists
 * with its recorded size and digest. The restore Job verifies the bytes. */
export const HostedBackupVerificationSchema = z
  .object({
    backupId: z.string().uuid(),
    verifiedAt: z.number().int().nonnegative(),
    reference: z.string().min(1),
    schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceGenerationId: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    workflows: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
  })
  .strict()
export type HostedBackupCatalog = z.infer<typeof HostedBackupCatalogSchema>
export type HostedBackupVerification = z.infer<typeof HostedBackupVerificationSchema>

export const HostedBackupIdSchema = z.object({ backupId: z.string().uuid() }).strict()
export type HostedBackupId = z.infer<typeof HostedBackupIdSchema>
