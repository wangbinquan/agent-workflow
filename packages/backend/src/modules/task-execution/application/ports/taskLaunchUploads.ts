import type { UploadFile, UploadInputDef, UploadLimits } from '../../domain/uploads'
import type { WorkspaceUploadResult } from './workspaceUploads'

/**
 * RFC-486: lands a launch's buffered uploads in the prepared worktree and records them as task input files. The
 * infrastructure adapter binds the database, the workspace upload content and the input file store.
 */
export interface TaskLaunchUploads {
  apply(
    input: Readonly<{
      taskId: string
      plan: Readonly<{
        worktreePath: string
        inputsSubdir?: string
        defs: ReadonlyMap<string, UploadInputDef>
        files: readonly UploadFile[]
        limits: UploadLimits
      }>
    }>,
  ): Promise<WorkspaceUploadResult>
}
