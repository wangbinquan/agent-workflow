import type { WorkspaceUploadContentFactory } from '../application/ports/workspaceUploadContent'
import { requireWorkspaceUploadContentFactory } from '../application/workspacePorts'
export { requireWorkspaceUploadContent } from '../application/workspacePorts'
import { createFileWorkspaceUploadContentFactory } from '../infrastructure/local/fileWorkspaceUploadContent'

/** Undefined alone chooses a complete native factory. Selection performs no IO. */
export function selectWorkspaceUploadContentFactory(
  selected?: WorkspaceUploadContentFactory,
): WorkspaceUploadContentFactory {
  const factory = selected === undefined ? createFileWorkspaceUploadContentFactory() : selected
  requireWorkspaceUploadContentFactory(factory)
  return factory
}
