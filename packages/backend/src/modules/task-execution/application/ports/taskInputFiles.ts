import type { UploadFile, UploadLimits } from '../../domain/uploads'

/** Original uploaded bytes belong to the task, independently of its mutable
 * worktree. A selected durable content owner supports restart after volume loss. */
export interface TaskInputFiles {
  retain(input: {
    readonly taskId: string
    readonly requestDigest: string
    readonly files: readonly UploadFile[]
    readonly limits: UploadLimits
  }): Promise<void>
  read(taskId: string): Promise<{
    readonly requestDigest: string
    readonly files: readonly UploadFile[]
    readonly limits: UploadLimits
  } | null>
}
