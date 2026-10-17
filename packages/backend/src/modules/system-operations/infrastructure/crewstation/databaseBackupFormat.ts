// RFC-370 v3 V5 — hosted database backup identity. A hosted backup is the
// standalone provider-neutral backup archive (manifest v2 + logical PostgreSQL
// artifact) with one hosted sidecar naming the installation it belongs to. The
// archive is a single CS object; nothing else is listed or pinned by a backup.
import { z } from 'zod'
import type { HostedStoredObject } from '@/platform/crewstation/objectStorage'
import {
  hostedObjectReference,
  parseHostedObjectReference,
} from '@/platform/crewstation/objectReference'

/** Publication owner of backup archives and the owner segment of their reference. */
export const HOSTED_BACKUP_OWNER = 'database-backup'
export const HOSTED_BACKUP_SIDECAR = 'hosted-backup.json'

export const HostedBackupContents = z
  .object({
    workflows: z.number().int().nonnegative(),
    skills: z.number().int().nonnegative(),
  })
  .strict()
export type HostedBackupContents = z.infer<typeof HostedBackupContents>

export const HostedBackupSidecar = z
  .object({
    format: z.literal('aw-hosted-database-backup-v2'),
    backupId: z.string().uuid(),
    kind: z.enum(['manual', 'scheduled']),
    installation: z.string().min(1),
    objectSpaceId: z.string().uuid(),
    keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.number().int().nonnegative(),
    snapshotAt: z.number().int().nonnegative(),
    schemaDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sourceGenerationId: z.string().regex(/^dbg_[A-Za-z0-9_-]{8,128}$/),
    contents: HostedBackupContents,
  })
  .strict()
export type HostedBackupSidecar = z.infer<typeof HostedBackupSidecar>

/** The restore reference handed to the platform administrator (CS RFC-042). */
export function hostedBackupReference(object: HostedStoredObject): string {
  return hostedObjectReference(HOSTED_BACKUP_OWNER, object)
}

export function parseHostedBackupReference(reference: string): HostedStoredObject {
  if (reference.length > 2048 || /[\r\n\0]/.test(reference))
    throw new Error('hosted-object-reference-invalid')
  return parseHostedObjectReference(HOSTED_BACKUP_OWNER, reference)
}

/** The generation source marker that proves a database was restored from a backup. */
export const hostedBackupMarker = (backupId: string): string => `hosted-backup:${backupId}`

export function parseHostedBackupMarker(source: unknown): string | null {
  const match = typeof source === 'string' ? /^hosted-backup:([a-f0-9-]{36})$/.exec(source) : null
  return match ? match[1]! : null
}

/** The logical copy operation of restoring exactly this archive. */
export const hostedRestoreCopyOperationId = (object: HostedStoredObject): string =>
  `dbm_hosted_restore_${object.sha256.slice(0, 40)}`
