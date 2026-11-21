import type { IsolationWorkspaceFactory } from '../application/ports/isolationWorkspace'
import { requireIsolationWorkspaceFactory } from '../application/workspacePorts'
export { requireIsolationWorkspaceScope } from '../application/workspacePorts'

/** Selection performs no IO; the caller's selection is required and only checked (RFC-527). */
export function selectIsolationWorkspaceFactory(
  selected: IsolationWorkspaceFactory,
): IsolationWorkspaceFactory {
  requireIsolationWorkspaceFactory(selected)
  return selected
}
