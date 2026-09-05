// RFC-310 PR-3 T36 —— 上传会话 store port（实现：infrastructure/uploadSessionStore，一份实现两个 provider 共用）。

export interface UploadSessionRow {
  readonly id: string
  readonly actorUserId: string | null
  readonly originalName: string
  readonly bytes: number
  readonly sha256: string
  readonly blobRef: string
  readonly state: string
  readonly claimedByMissionId: string | null
  readonly expiresAt: number
  readonly createdAt: number
}

export interface UploadSessionPersistence {
  createUpload(input: {
    readonly actorUserId: string | null
    readonly originalName: string
    readonly bytes: number
    readonly sha256: string
    readonly blobRef: string
    readonly idempotencyKey: string | null
    readonly now: number
  }): Promise<UploadSessionRow>
  getUpload(id: string): Promise<UploadSessionRow | null>
  /** 仅本人 + pending 可删；他人 ref 与不存在同形（404）。 */
  deleteUpload(id: string, actorUserId: string | null): Promise<void>
  /** 全有或全无的原子 claim；成功返回按输入序的行。 */
  claimUploads(input: {
    readonly missionId: string
    readonly actorUserId: string | null
    readonly uploadRefs: readonly string[]
    readonly now: number
  }): Promise<UploadSessionRow[]>
  sweepExpired(now: number, limit?: number): Promise<number>
}
