import type { IsolationWorkspaceFactory } from '../application/ports/isolationWorkspace'
import { requireIsolationWorkspaceFactory } from '../application/workspacePorts'
export { requireIsolationWorkspaceScope } from '../application/workspacePorts'
import { createLocalIsolationWorkspaceFactory } from '../infrastructure/local/localIsolationWorkspace'

/** Selection performs no IO; explicit incomplete choices never fall back. */
export function selectIsolationWorkspaceFactory(
  selected?: IsolationWorkspaceFactory,
): IsolationWorkspaceFactory {
  const factory = selected === undefined ? createLocalIsolationWorkspaceFactory() : selected
  requireIsolationWorkspaceFactory(factory)
  return factory
}
