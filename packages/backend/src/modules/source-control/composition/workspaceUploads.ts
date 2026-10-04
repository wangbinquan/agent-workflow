import type {
  WorkspaceUploadContent,
  WorkspaceUploadContentFactory,
} from '../application/ports/workspaceUploadContent'
import { createFileWorkspaceUploadContentFactory } from '../infrastructure/local/fileWorkspaceUploadContent'

export function requireWorkspaceUploadContent(
  value: unknown,
): asserts value is WorkspaceUploadContent {
  const methods: readonly (keyof WorkspaceUploadContent)[] = [
    'prepareTarget',
    'file',
    'entry',
    'read',
    'remove',
    'write',
  ]
  if (
    value === null ||
    typeof value !== 'object' ||
    methods.some((name) => typeof (value as WorkspaceUploadContent)[name] !== 'function')
  ) {
    throw new TypeError('Workspace uploads require a complete content receiver')
  }
}

/** Undefined alone chooses a complete native factory. Selection performs no IO. */
export function selectWorkspaceUploadContentFactory(
  selected?: WorkspaceUploadContentFactory,
): WorkspaceUploadContentFactory {
  const factory = selected === undefined ? createFileWorkspaceUploadContentFactory() : selected
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Workspace uploads require a complete content factory')
  }
  return factory
}
