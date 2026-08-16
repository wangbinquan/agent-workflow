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

    async commitWorktree({ repoPath, worktreePath, message, keepRef, authorName, authorEmail }) {
      // `add -A` rather than `add -u`: an agent's fix routinely adds a file
      // (a new test, an extracted module), and staging only tracked paths would
      // freeze a commit that does not build.
      const staged = await runGit(worktreePath, ['add', '-A'], opts)
      if (staged.exitCode !== 0) {
        return {
          ok: false,
          reason: 'failed',
          error: describeGitFailure(staged.stderr, staged.exitCode),
        }
      }

      // `--quiet --exit-code` reports 1 when something is staged. An empty
      // commit is not an error here — the agent looked and changed nothing —
      // but it must not be posted as a patch, so it comes back as `no-changes`.
      const dirty = await runGit(worktreePath, ['diff', '--cached', '--quiet', '--exit-code'], opts)
      if (dirty.exitCode === 0) return { ok: false, reason: 'no-changes' }

      const identity: string[] = []
      if (authorName !== undefined && authorName !== '') {
        identity.push('-c', `user.name=${authorName}`, '-c', `author.name=${authorName}`)
      }
      if (authorEmail !== undefined && authorEmail !== '') {
        identity.push('-c', `user.email=${authorEmail}`, '-c', `author.email=${authorEmail}`)
      }

      const committed = await runGit(
        worktreePath,
        [...identity, 'commit', '--no-verify', '--no-gpg-sign', '-m', message],
        opts,
      )
      if (committed.exitCode !== 0) {
        return {
          ok: false,
          reason: 'failed',
          error: describeGitFailure(committed.stderr, committed.exitCode),
        }
      }

      const resolved = await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD^{commit}'], opts)
      const commitSha = resolved.stdout.trim()
      if (resolved.exitCode !== 0 || commitSha === '') {
        return {
          ok: false,
          reason: 'failed',
          error: `committed but could not resolve HEAD: ${describeGitFailure(resolved.stderr, resolved.exitCode)}`,
        }
      }

      // The keep-alive ref, written into the COMMON repository rather than the
      // worktree: the worktree is about to be deleted, and a commit reachable
      // only from its detached HEAD is prunable by `git gc` while a human is
      // still deciding whether to accept it.
      const kept = await runGit(repoPath, ['update-ref', keepRef, commitSha], opts)
      if (kept.exitCode !== 0) {
        return {
          ok: false,
          reason: 'failed',
          error: `froze ${commitSha.slice(0, 12)} but could not keep it alive: ${describeGitFailure(kept.stderr, kept.exitCode)}`,
        }
      }

      return { ok: true, commitSha }
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

    async readWorktreeDiff({ worktreePath }) {
      // `add -A --intent-to-add` first, then `diff` — the only way `git diff`
      // reports a NEW file. Without it an agent that added a module shows a
      // diff missing the module, which reads as a change that cannot compile.
      // `--intent-to-add` records the path without staging content, so the
      // tree is left exactly as the agent left it.
      const marked = await runGit(worktreePath, ['add', '-A', '--intent-to-add'], opts)
      if (marked.exitCode !== 0) {
        return { ok: false, error: describeGitFailure(marked.stderr, marked.exitCode) }
      }

      const result = await runGit(worktreePath, ['diff', '--no-color', '--unified=3'], opts)
      return result.exitCode === 0
        ? { ok: true, diff: result.stdout }
        : { ok: false, error: describeGitFailure(result.stderr, result.exitCode) }
    },

    async pushCommit({ repoPath, commitSha, branch, expectedRemoteSha }) {
      // A compare-and-swap push. Plain `push` would succeed by fast-forwarding
      // over whatever arrived while the platform was waiting for a human, and
      // `--force` would discard it outright; `--force-with-lease=<ref>:<sha>`
      // refuses unless the remote is still exactly where it was checked.
      const result = await runGit(
        repoPath,
        [
          'push',
          `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`,
          remote,
          `${commitSha}:refs/heads/${branch}`,
        ],
        opts,
      )
      if (result.exitCode === 0) return { ok: true }

      const error = describeGitFailure(result.stderr, result.exitCode)
      // git reports a lease failure as `stale info` / `rejected`. Distinguished
      // because the two need different words on the merge request: a stale
      // branch is "somebody pushed, here is a fresh one", while a real failure
      // is "this needs a person".
      const stale = /stale info|non-fast-forward|rejected/i.test(error)
      return stale ? { ok: false, reason: 'stale', error } : { ok: false, reason: 'failed', error }
    },

    async pushNewBranch({ repoPath, commitSha, branch }) {
      // No `--force` and no lease: creating a ref that does not exist needs
      // neither, and a plain push is refused by the remote if it does exist and
      // this is not a fast-forward — which is the outcome we want to hear about
      // rather than override.
      const result = await runGit(
        repoPath,
        ['push', remote, `${commitSha}:refs/heads/${branch}`],
        opts,
      )
      if (result.exitCode === 0) return { ok: true }

      const error = describeGitFailure(result.stderr, result.exitCode)
      // A name collision is ordinary — two rounds on one issue, or a leftover
      // branch from a previous attempt — and the caller renames rather than
      // treating it as a failure needing a person.
      const exists = /already exists|non-fast-forward|fetch first|rejected/i.test(error)
      return exists
        ? { ok: false, reason: 'exists', error }
        : { ok: false, reason: 'failed', error }
    },

    async deleteRef({ repoPath, ref }) {
      const result = await runGit(repoPath, ['update-ref', '-d', ref], opts)
      return result.exitCode === 0
        ? { ok: true }
        : { ok: false, error: describeGitFailure(result.stderr, result.exitCode) }
    },
  }
}
