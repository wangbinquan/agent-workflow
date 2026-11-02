// RFC-346 — transport-neutral backup receipt owned by System Operations.

export interface AdminBackupReceipt {
  readonly path: string
  readonly sizeBytes: number
  readonly contents: Readonly<{
    workflows: number
    skills: number
    db: boolean
    config: boolean
  }>
}

/**
 * RFC-426: what a scheduled backup is (`docs/disaster-recovery.md` §1.2 / §6) — the rotatable `scheduled` family, without
 * worktrees. Every deployment's scheduled backup asks its backup coordinator for exactly this.
 */
export const SCHEDULED_BACKUP_REQUEST = Object.freeze({
  includeWorktrees: false,
  kind: 'scheduled',
} as const)

export function projectAdminBackupReceipt(receipt: AdminBackupReceipt): AdminBackupReceipt {
  return Object.freeze({
    path: receipt.path,
    sizeBytes: receipt.sizeBytes,
    contents: Object.freeze({
      workflows: receipt.contents.workflows,
      skills: receipt.contents.skills,
      db: receipt.contents.db,
      config: receipt.contents.config,
    }),
  })
}
