// Native compatibility entry. Production selected effects are bound in DA composition.
import {
  adoptActionWorkspace as adoptSelectedActionWorkspace,
  materializeActionWorkspace as materializeSelectedActionWorkspace,
} from '../application/actionWorkspace'
import type {
  MaterializeInput,
  MaterializedWorkspace,
  WorkspaceDeps,
} from '../application/actionWorkspace'
import { createFileActionWorkspaceEffects } from './local/fileActionWorkspaceEffects'
export type {
  MaterializeInput,
  MaterializedWorkspace,
  WorkspaceDeps,
} from '../application/actionWorkspace'
export { businessTreeDigestOf, discardWorkspace } from './local/fileActionWorkspaceEffects'

export function materializeActionWorkspace(
  deps: WorkspaceDeps,
  input: MaterializeInput,
): Promise<MaterializedWorkspace> {
  return materializeSelectedActionWorkspace(deps, input, createFileActionWorkspaceEffects())
}

export function adoptActionWorkspace(
  deps: Pick<WorkspaceDeps, 'evidence'>,
  input: Parameters<typeof adoptSelectedActionWorkspace>[1],
): Promise<MaterializedWorkspace> {
  return adoptSelectedActionWorkspace(deps, input, createFileActionWorkspaceEffects())
}
