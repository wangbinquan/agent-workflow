// RFC-304 — the `GitPort` implementation, over the platform's `runGit`.
//
// `runGit` never throws and reports the exit code, which suits a port whose
// failures are ordinary outcomes: a missing MR ref is the expected answer on an
// instance that prunes them, not an exception.
//
// The fetch writes to FETCH_HEAD and resolves it in the same call. Resolving in
// a separate step would let a concurrent fetch in the same repository move
// FETCH_HEAD in between, and the round would then proceed against a commit it
// never actually checked — the same class of bug as trusting a moving MR ref,
// arriving through a different door.

import { runGit, withWorktreeRegistryLock } from '@/util/git'
import type { GitFetchResult, GitPort } from '@/modules/code-capability/ports/gitPort'
import type { TaskWorkspaceCommitParticipant } from '@/modules/task-execution/public/participants'

/** What a fetch failure should say when git wrote nothing useful. */
function describeGitFailure(stderr: string, exitCode: number): string {
  const text = stderr.trim()
  if (text !== '') return text.split('\n').slice(0, 3).join('; ')
  return `git exited with code ${exitCode}`
}

export interface GitAdapterDeps {
  /** The remote to fetch from — the target repository's own origin. */
  remote?: string
  signal?: AbortSignal
  timeoutMs?: number
  /** RFC-308: task-execution-minted authority for this round workspace. */
  taskCommit?: TaskWorkspaceCommitParticipant
}

export function createGitAdapter(deps: GitAdapterDeps = {}): GitPort {
  const remote = deps.remote ?? 'origin'
  const opts = {
    ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
  }

  return {
    async fetchRef({ repoPath, refspec }): Promise<GitFetchResult> {
      const fetched = await runGit(repoPath, ['fetch', '--no-tags', remote, refspec], opts)
      if (fetched.exitCode !== 0) {
        return { ok: false, error: describeGitFailure(fetched.stderr, fetched.exitCode) }
      }

      const resolved = await runGit(
        repoPath,
        ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
        opts,
      )
      if (resolved.exitCode !== 0) {
        // The fetch reported success but left nothing resolvable. Reported as a
        // fetch failure rather than swallowed, so the chain moves to the next
        // attempt instead of judging an empty sha against the baseline.
        return {
          ok: false,
          error: `fetched ${refspec} but could not resolve FETCH_HEAD: ${describeGitFailure(resolved.stderr, resolved.exitCode)}`,
        }
      }

      const sha = resolved.stdout.trim()
      if (sha === '') return { ok: false, error: `resolved ${refspec} to an empty commit id` }
      return { ok: true, resolvedSha: sha }
    },

    async checkoutDetached({ worktreePath, sha }) {
      const result = await runGit(worktreePath, ['checkout', '--detach', sha], opts)
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, error: describeGitFailure(result.stderr, result.exitCode) }
    },

    async addDisposableWorktree({ repoPath, worktreePath, sha }) {
      // Under the registry lock: `worktree add` rewrites the COMMON git dir's
      // worktrees registry, and shards run concurrently on one repository. The
      // 2026-07-27 half-initialized-commondir incident in this repo is the
      // proof that racing here corrupts for real, not in theory.
      const result = await withWorktreeRegistryLock(repoPath, () =>
        // `--detach`: a shard tree is scratch and must never own a branch, or a
        // second shard on the same sha would fail with "already checked out".
        // `--force`: the sha may already be checked out by the round's own
        // primary worktree, which is the normal case, not an error.
        runGit(repoPath, ['worktree', 'add', '--detach', '--force', worktreePath, sha], opts),
      )
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, error: describeGitFailure(result.stderr, result.exitCode) }
    },

    async removeDisposableWorktree({ repoPath, worktreePath }) {
      // `--force` because the agent was allowed to modify the tree (B8): a
      // clean-tree-only removal would leave every shard that ran a test behind
      // as a permanent leak.
      const result = await withWorktreeRegistryLock(repoPath, () =>
        runGit(repoPath, ['worktree', 'remove', '--force', worktreePath], opts),
      )
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, error: describeGitFailure(result.stderr, result.exitCode) }
    },

    async commitWorktree({ message, keepRef, authorName, authorEmail }) {
      if (deps.taskCommit === undefined) {
        return {
          ok: false,
          reason: 'failed',
          error: 'task workspace commit participant is not wired',
        }
      }
      const frozen = await deps.taskCommit.freeze({
        message,
        keepRef,
        ...(authorName !== undefined ? { authorName } : {}),
        ...(authorEmail !== undefined ? { authorEmail } : {}),
      })
      return frozen.ok
        ? { ok: true, commitSha: frozen.commitSha }
        : frozen.reason === 'no-changes'
          ? { ok: false, reason: 'no-changes' }
          : { ok: false, reason: 'failed', error: frozen.error }
    },

    async readCommitDiff({ repoPath, commitSha }) {
      // `show` against the commit's first parent. `--format=` drops the commit
      // header so the output is a plain unified diff the diff parsers accept.
      const result = await runGit(
        repoPath,
        ['show', '--format=', '--no-color', '--unified=3', commitSha],
        opts,
      )
      return result.exitCode === 0
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: describeGitFailure(result.stderr, result.exitCode) }
    },

    async readWorktreeDiff({ worktreePath: _worktreePath }) {
      const result =
        deps.taskCommit === undefined
          ? { ok: false as const, error: 'task workspace commit participant is not wired' }
          : await deps.taskCommit.preview()
      return result.ok ? { ok: true, diff: result.diff } : result
    },

    async pushCommit({ repoPath: _repoPath, commitSha, branch, expectedRemoteSha }) {
      if (deps.taskCommit === undefined) {
        return {
          ok: false,
          reason: 'failed',
          error: 'task workspace commit participant is not wired',
        }
      }
      const publication = await deps.taskCommit.publish({
        mode: 'cas',
        baseSha: expectedRemoteSha,
        tipSha: commitSha,
        remote,
        branch,
      })
      if (!publication.ok) {
        const error =
          publication.reason === 'excluded-history'
            ? `push blocked: outgoing history contains ${publication.excludedPaths.length} excluded path(s)`
            : publication.error
        const stale = /stale info|non-fast-forward|rejected/i.test(error)
        return {
          ok: false,
          reason: publication.reason === 'failed' && stale ? 'stale' : 'failed',
          error,
        }
      }
      return { ok: true }
    },

    async pushNewBranch({ repoPath, commitSha, branch }) {
      const parent = await runGit(repoPath, ['rev-parse', '--verify', `${commitSha}^`], opts)
      const baseSha = parent.stdout.trim()
      if (parent.exitCode !== 0 || baseSha === '') {
        return {
          ok: false,
          reason: 'failed',
          error: 'cannot resolve artifact parent; push refused',
        }
      }
      if (deps.taskCommit === undefined) {
        return {
          ok: false,
          reason: 'failed',
          error: 'task workspace commit participant is not wired',
        }
      }
      const publication = await deps.taskCommit.publish({
        mode: 'new',
        baseSha,
        tipSha: commitSha,
        remote,
        branch,
      })
      if (!publication.ok) {
        const error =
          publication.reason === 'excluded-history'
            ? `push blocked: outgoing history contains ${publication.excludedPaths.length} excluded path(s)`
            : publication.error
        const exists = /already exists|non-fast-forward|fetch first|rejected/i.test(error)
        return {
          ok: false,
          reason: publication.reason === 'failed' && exists ? 'exists' : 'failed',
          error,
        }
      }
      return { ok: true }
    },

    async deleteRef({ repoPath: _repoPath, ref }) {
      return deps.taskCommit === undefined
        ? { ok: false, error: 'task workspace commit participant is not wired' }
        : deps.taskCommit.release({ ref })
    },
  }
}
