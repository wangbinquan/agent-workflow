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
