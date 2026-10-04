import type {
  IsolationWorkspaceFactory,
  IsolationWorkspaceScope,
} from '../application/ports/isolationWorkspace'
import { createLocalIsolationWorkspaceFactory } from '../infrastructure/local/localIsolationWorkspace'

export function requireIsolationWorkspaceScope(
  value: unknown,
): asserts value is IsolationWorkspaceScope {
  const methods: readonly (keyof IsolationWorkspaceScope)[] = [
    'recoverKey',
    'chooseGeneration',
    'create',
    'restore',
    'head',
    'submodulePresence',
    'changedFiles',
    'blobHashes',
    'snapshot',
    'merge',
    'undoShard',
    'discard',
    'resolveConflict',
    'completeHumanConflict',
  ]
  if (
    value === null ||
    typeof value !== 'object' ||
    methods.some((name) => typeof (value as IsolationWorkspaceScope)[name] !== 'function')
  ) {
    throw new TypeError('Isolation requires a complete workspace scope')
  }
}

/** Selection performs no IO; explicit incomplete choices never fall back. */
export function selectIsolationWorkspaceFactory(
  selected?: IsolationWorkspaceFactory,
): IsolationWorkspaceFactory {
  const factory = selected === undefined ? createLocalIsolationWorkspaceFactory() : selected
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Isolation requires a complete workspace factory')
  }
  return factory
}
