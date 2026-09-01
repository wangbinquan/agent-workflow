export interface EmployeeInputUploadRecord {
  readonly id: string
  readonly actorUserId: string | null
  readonly originalName: string
  readonly bytes: number
  readonly sha256: string
  readonly blobRef: string
  readonly state: 'pending' | 'claimed'
  readonly claimedByCaseId: string | null
  readonly expiresAt: number
  readonly createdAt: number
}

/** Provider-neutral temporary input persistence used by admission and maintenance. */
export interface EmployeeInputUploadPersistence {
  create(input: {
    readonly actorUserId: string | null
    readonly originalName: string
    readonly bytes: number
    readonly sha256: string
    readonly blobRef: string
    readonly idempotencyKey: string | null
    readonly now: number
  }): Promise<EmployeeInputUploadRecord>
  resolveForCase(input: {
    readonly ids: readonly string[]
    readonly actorUserId: string | null
    readonly caseId: string
    readonly now: number
  }): Promise<EmployeeInputUploadRecord[]>
  delete(id: string, actorUserId: string | null): Promise<void>
  sweepExpired(now: number, limit?: number): Promise<number>
}
