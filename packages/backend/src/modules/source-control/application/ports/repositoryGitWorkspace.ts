import type { RepositoryPreviewIndexScope } from './repositoryPreviewIndex'
import type {
  CommitPreparedResult,
  PrepareRepositoryCommitResult,
  RepositoryCommitPreviewResult,
} from '../../public/types'

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

/** Git options that can cross into another environment (no abort signal). */
export type RepositoryCommitGitOptions = Omit<RepositoryGitOptions, 'signal'>

/** RFC-370 §9.2 V3 — commit use cases a scope executes where the repository
 * lives: each is ONE remote operation running the same native function, not
 * one round trip per Git step. Absent for the native scope. */
export interface RepositoryCommitWorkspaceOperations {
  prepare(input: {
    readonly configuredPatterns: readonly string[]
    readonly gitOptions?: RepositoryCommitGitOptions
  }): Promise<PrepareRepositoryCommitResult>
  commitPrepared(input: {
    readonly message: string
    readonly verification: 'normal' | 'artifact'
    readonly authorName?: string | null
    readonly authorEmail?: string | null
    readonly gitOptions?: RepositoryCommitGitOptions
  }): Promise<CommitPreparedResult>
  preview(input: {
    readonly configuredPatterns: readonly string[]
    readonly gitOptions?: RepositoryCommitGitOptions
  }): Promise<RepositoryCommitPreviewResult>
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
  readonly commitOperations?: RepositoryCommitWorkspaceOperations
}

export interface RepositoryGitWorkspaceFactory {
  /** Synchronous logical binding, with no filesystem or process activity. */
  bind(binding: RepositoryGitWorkspaceBinding): RepositoryGitWorkspaceScope
}
