import { prepareWorkspaceRollbackPlan as prepareWorkspaceRollbackPlanInternal } from '../application/prepareWorkspaceRollbackPlan'
import { GitWorkspaceRollbackSnapshotInspector } from './gitWorkspaceRollbackSnapshotInspector'

export function prepareWorkspaceRollbackPlan(
  input: Omit<Parameters<typeof prepareWorkspaceRollbackPlanInternal>[0], 'inspector'> &
    Partial<Pick<Parameters<typeof prepareWorkspaceRollbackPlanInternal>[0], 'inspector'>>,
) {
  return prepareWorkspaceRollbackPlanInternal({
    ...input,
    inspector: input.inspector ?? new GitWorkspaceRollbackSnapshotInspector(),
  })
}
