import type { RepositoryPreviewIndexScope } from './repositoryPreviewIndex'

export interface RepositoryGitOptions {
  env?: Record<string, string | undefined>
  stdin?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface RepositoryGitOutcome {
  stdout: string
  stderr: string
  exitCode: number
}

/** Logical references are interpreted only by the selected workspace factory. */
export interface RepositoryGitWorkspaceBinding {
  readonly taskId: string
  readonly workspaceRef: string
  readonly repositoryRef: string
}

/** One submodule as reported by `git submodule status --recursive`. */
export interface SubmoduleEntry {
  /**
   * Path relative to the superproject root, nested levels joined with '/'
   * (e.g. 'vendor/inner'). MAY CONTAIN SPACES — never interpolate it into a
   * git refname (see `subSlug`).
   */
  path: string
  /**
   * The submodule's WORKING-TREE HEAD — NOT the gitlink recorded in the
   * superproject index. The two diverge the moment a node commits inside the
   * submodule, which is precisely RFC-210's main scenario.
   */
  headSha: string
  /** ' ' in sync · '+' differs from index · '-' not initialized · 'U' conflicted. */
  flag: ' ' | '+' | '-' | 'U'
  /**
   * Number of '/'-separated segments. ONLY meaningful for bottom-up ordering
   * (a containing path is always strictly shorter than what it contains).
   * NOT a nesting level: 'vendor/libs/foo' can be a first-level submodule.
   */
  pathDepth: number
}

/** A complete receiver for local repository effects, including its candidate index. */
export interface RepositoryGitWorkspaceScope {
  readonly workspaceRef: string
  run(args: readonly string[], options?: RepositoryGitOptions): Promise<RepositoryGitOutcome>
  hasSubmodules(): boolean | Promise<boolean>
  effectiveSubmodules(): SubmoduleEntry[] | Promise<SubmoduleEntry[]>
  withPreviewIndex<Result>(
    operation: (index: RepositoryPreviewIndexScope) => Promise<Result>,
    options?: RepositoryGitOptions,
  ): Promise<Result>
  /** Synchronous logical binding; physical effects remain in the methods above. */
  subrepository(relativePath: string): RepositoryGitWorkspaceScope
}

export interface RepositoryGitWorkspaceFactory {
  /** Synchronous logical binding, with no filesystem or process activity. */
  bind(binding: RepositoryGitWorkspaceBinding): RepositoryGitWorkspaceScope
}
