import type { WorkspaceUploadContentFactory } from '../application/ports/workspaceUploadContent'
import { requireWorkspaceUploadContentFactory } from '../application/workspacePorts'
export { requireWorkspaceUploadContent } from '../application/workspacePorts'

/** The caller's selection is required (RFC-527). Selection performs no IO. */
export function selectWorkspaceUploadContentFactory(
  selected: WorkspaceUploadContentFactory,
): WorkspaceUploadContentFactory {
  requireWorkspaceUploadContentFactory(selected)
  return selected
}
