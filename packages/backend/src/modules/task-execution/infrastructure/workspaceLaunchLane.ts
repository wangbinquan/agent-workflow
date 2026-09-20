import type { FrozenRepositoryPreparationRef } from '@/modules/source-control/public/types'
import type {
  PreparedUploadArtifactRef,
  TaskWorkspaceLaunchLane,
  WorkspacePreparationPlanRef,
} from '../application/ports/workspaceLaunch'

/** Called only by the Task owner after the matching journal admission CAS. */
export function preparedArtifactLane(id: string): TaskWorkspaceLaunchLane {
  return {
    kind: 'pre-materialized',
    artifact: `task:artifact:v1:${id}` as PreparedUploadArtifactRef,
  }
}
export function repositoryPreparationLane(
  id: string,
  source: FrozenRepositoryPreparationRef,
): TaskWorkspaceLaunchLane {
  return {
    kind: 'repository-preparation',
    source,
    plan: `task:plan:v1:${id}` as WorkspacePreparationPlanRef,
  }
}
