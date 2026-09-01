import type { UploadSessionRow } from './ports/uploadSessionStore'

/** Provider-neutral persistence used by the mission input upload transport. */
export interface MissionInputUploadPersistence {
  get(uploadRef: string): Promise<UploadSessionRow | null>
  create(input: {
    readonly actorUserId: string | null
    readonly originalName: string
    readonly bytes: number
    readonly sha256: string
    readonly blobRef: string
    readonly idempotencyKey: string | null
    readonly now: number
  }): Promise<UploadSessionRow>
  delete(input: { readonly uploadRef: string; readonly actorUserId: string | null }): Promise<void>
}

/** Filesystem/content-addressed storage stays outside database transactions. */
export interface MissionInputBlobPersistence {
  putFile(absolutePath: string): Promise<{ readonly sha256: string; readonly bytes: number }>
}

export interface MissionInputUploadOperations {
  create(input: {
    readonly absolutePath: string
    readonly originalName: string
    readonly actorUserId: string | null
    readonly idempotencyKey: string | null
  }): Promise<UploadSessionRow>
  delete(input: { readonly uploadRef: string; readonly actorUserId: string | null }): Promise<void>
}

export function createMissionInputUploadOperations(deps: {
  readonly persistence: MissionInputUploadPersistence
  readonly blobs: MissionInputBlobPersistence
  readonly now?: () => number
}): MissionInputUploadOperations {
  const now = deps.now ?? Date.now
  return {
    async create(input) {
      const blob = await deps.blobs.putFile(input.absolutePath)
      return await deps.persistence.create({
        actorUserId: input.actorUserId,
        originalName: input.originalName,
        bytes: blob.bytes,
        sha256: blob.sha256,
        blobRef: blob.sha256,
        idempotencyKey: input.idempotencyKey,
        now: now(),
      })
    },
    async delete(input) {
      await deps.persistence.delete(input)
    },
  }
}
