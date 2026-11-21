// RFC-511 — workspace port completeness checks: a selected isolation, Git, upload, exclude or read implementation is complete,
// or the assembly fails. Selection itself stays in composition.
import type { WorkspaceExcludeParticipant } from '../public/participants'
import type { IsolationWorkspaceFactory, IsolationWorkspaceScope } from './ports/isolationWorkspace'
import type {
  RepositoryGitWorkspaceFactory,
  RepositoryGitWorkspaceScope,
} from './ports/repositoryGitWorkspace'
import type { RepositoryWorkspaceReadQueries } from './ports/repositoryWorkspaceReadQueries'
import type {
  WorkspaceUploadContent,
  WorkspaceUploadContentFactory,
} from './ports/workspaceUploadContent'

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

export function requireIsolationWorkspaceFactory(factory: IsolationWorkspaceFactory): void {
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Isolation requires a complete workspace factory')
  }
}

export function requireRepositoryGitWorkspaceScope(
  value: unknown,
): asserts value is RepositoryGitWorkspaceScope {
  const methods: readonly (keyof RepositoryGitWorkspaceScope)[] = [
    'run',
    'hasSubmodules',
    'effectiveSubmodules',
    'withPreviewIndex',
    'subrepository',
  ]
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as RepositoryGitWorkspaceScope).workspaceRef !== 'string' ||
    methods.some((name) => typeof (value as RepositoryGitWorkspaceScope)[name] !== 'function')
  ) {
    throw new TypeError('Repository Git requires a complete workspace scope')
  }
}

export function requireRepositoryGitWorkspaceFactory(factory: RepositoryGitWorkspaceFactory): void {
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Repository Git requires a complete workspace factory')
  }
}

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

export function requireWorkspaceUploadContentFactory(factory: WorkspaceUploadContentFactory): void {
  if (factory === null || typeof factory !== 'object' || typeof factory.bind !== 'function') {
    throw new TypeError('Workspace uploads require a complete content factory')
  }
}

export function requireWorkspaceExcludeParticipant(participant: WorkspaceExcludeParticipant): void {
  if (
    participant === null ||
    typeof participant !== 'object' ||
    typeof participant.ensure !== 'function'
  ) {
    throw new TypeError('Workspace exclude requires a complete profile participant')
  }
}

export function requireRepositoryWorkspaceReadQueries(
  queries: RepositoryWorkspaceReadQueries,
): void {
  const methods: readonly (keyof RepositoryWorkspaceReadQueries)[] = [
    'exists',
    'isGitWorkTree',
    'gitDiffSnapshot',
    'worktreeDiff',
    'isolationRoot',
  ]
  if (
    queries === null ||
    typeof queries !== 'object' ||
    methods.some((name) => typeof queries[name] !== 'function')
  ) {
    throw new TypeError('Repository workspace reads require a complete query implementation')
  }
}
