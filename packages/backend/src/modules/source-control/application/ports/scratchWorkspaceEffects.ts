import type { GitCommitIdentity } from '@agent-workflow/shared'
import type { MaterializedSpace, WorkspaceCleanupReport } from '../workspaceMaterialization'

/** One Task-owned preparation and compensation, without an SC lease. */
export interface ScratchWorkspaceEffects {
  prepare(input: {
    readonly taskId: string
    readonly gitCommitIdentity: GitCommitIdentity | null
    readonly signal: AbortSignal
    readonly assertCurrent: () => Promise<void>
  }): Promise<MaterializedSpace>
  /** The owner has already validated the existing version/task/kind envelope. */
  restore(taskId: string, space: MaterializedSpace): MaterializedSpace | Promise<MaterializedSpace>
  cleanup(input: {
    readonly taskId: string
    readonly assertCurrent: () => Promise<void>
  }): Promise<WorkspaceCleanupReport>
}
