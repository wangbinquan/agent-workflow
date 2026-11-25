// Native compatibility entry. Production selected effects are bound in DA composition.
// RFC-584: moved verbatim from development-automation infrastructure/actionWorkspace.ts — only contract tests use it; no production entry reaches it.
import {
  adoptActionWorkspace as adoptSelectedActionWorkspace,
  materializeActionWorkspace as materializeSelectedActionWorkspace,
} from '@/modules/development-automation/application/actionWorkspace'
import type {
  MaterializeInput,
  MaterializedWorkspace,
  WorkspaceDeps,
} from '@/modules/development-automation/application/actionWorkspace'
import { createFileActionWorkspaceEffects } from '@/modules/development-automation/infrastructure/local/fileActionWorkspaceEffects'
export type {
  MaterializeInput,
  MaterializedWorkspace,
  WorkspaceDeps,
} from '@/modules/development-automation/application/actionWorkspace'
export {
  businessTreeDigestOf,
  discardWorkspace,
} from '@/modules/development-automation/infrastructure/local/fileActionWorkspaceEffects'

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
