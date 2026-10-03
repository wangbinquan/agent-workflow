import type {
  WorkspaceListRequest,
  WorkspaceReadRequest,
  WorkspaceEntryPage,
  BoundedWorkspaceContent,
} from '../../public/types'

/** Complete content effects for one opaque workspace binding. */
export interface WorkspaceContentEffects {
  list(request: WorkspaceListRequest): Promise<WorkspaceEntryPage>
  read(request: WorkspaceReadRequest): Promise<BoundedWorkspaceContent>
}

/** Binding retains the chosen receiver throughout a query's lifetime. */
export interface WorkspaceContentEffectsFactory {
  bind(workspaceRef: string): WorkspaceContentEffects
}
