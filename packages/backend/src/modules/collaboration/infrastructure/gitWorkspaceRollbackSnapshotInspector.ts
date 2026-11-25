import { gitCommitExists } from '@/platform/workspace/local/gitQueries'
import type { WorkspaceRollbackSnapshotInspector } from '../application/prepareWorkspaceRollbackPlan'

export class GitWorkspaceRollbackSnapshotInspector implements WorkspaceRollbackSnapshotInspector {
  snapshotExists(input: { worktreePath: string; snapshot: string }): Promise<boolean> {
    return gitCommitExists(input.worktreePath, input.snapshot)
  }
}
