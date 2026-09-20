/** RFC-362 Task-owned contracts; RFC-363 binds the workspace reader, launch cutover follows. */
import type {
  FrozenRepositoryPreparationRef,
  WorkspaceListRequest,
  WorkspaceReadRequest,
  WorkspaceEntryPage,
  BoundedWorkspaceContent,
} from '../../../source-control/public/types'

declare const workspaceReadBrand: unique symbol
declare const workspacePreparationPlanBrand: unique symbol
declare const preparedUploadArtifactBrand: unique symbol
export interface WorkspaceReadCapability {
  readonly [workspaceReadBrand]: 'task-bound-workspace-read'
}
export type WorkspacePreparationPlanRef = string & {
  readonly [workspacePreparationPlanBrand]: 'task-workspace-plan'
}
export type PreparedUploadArtifactRef = string & {
  readonly [preparedUploadArtifactBrand]: 'task-prepared-upload'
}
export type TaskWorkspaceLaunchLane =
  | {
      readonly kind: 'repository-preparation'
      readonly source: FrozenRepositoryPreparationRef
      readonly plan: WorkspacePreparationPlanRef
      readonly artifact?: never
    }
  | {
      readonly kind: 'pre-materialized'
      readonly artifact: PreparedUploadArtifactRef
      readonly source?: never
      readonly plan?: never
    }
export interface TaskWorkspaceReadPort {
  list(
    capability: WorkspaceReadCapability,
    request: WorkspaceListRequest,
  ): Promise<WorkspaceEntryPage>
  read(
    capability: WorkspaceReadCapability,
    request: WorkspaceReadRequest,
  ): Promise<BoundedWorkspaceContent>
}
