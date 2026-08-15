// RFC-304 — the git operations `prepare-worktree` needs, and nothing else.
//
// `util/git.ts` is large and does much more; a capability needs a handful of
// verbs.
// Keeping the port this small is what lets `prepareWorktree` be tested without
// a repository on disk — the decision logic it carries (which refs to try, what
// a moved head means) is the part worth testing, and it would otherwise be
// reachable only through a real clone.

export type GitFetchResult =
  | { readonly ok: true; readonly resolvedSha: string }
  | { readonly ok: false; readonly error: string }

export interface GitPort {
  /**
   * Fetch one refspec from the repository's own origin and resolve what came
   * back to a commit sha.
   *
   * Resolution is part of this call rather than a separate `revParse`: the
   * fetched ref has to be resolved in the same step that fetched it, or a
   * concurrent fetch can move it in between and the round proceeds against a
   * commit it never checked.
   */
  fetchRef(input: { repoPath: string; refspec: string }): Promise<GitFetchResult>

  /** Put the worktree at a commit, detached. */
  checkoutDetached(input: {
    worktreePath: string
    sha: string
  }): Promise<{ ok: true } | { ok: false; error: string }>

  /**
   * A throwaway writable worktree at `sha`, for one review shard.
   *
   * Each shard gets its OWN tree (design §6.1 P1). Sharing one would break
   * determinism outright: B8 lets a reviewing agent run tests and even try
   * edits, so on a shared tree the shards would see — and overwrite — each
   * other's scratch changes, and the same input would produce different
   * findings on a re-run.
   *
   * `git worktree add` mutates the COMMON git dir's registry, so concurrent
   * shards must serialize on it; the adapter does that with the daemon's
   * existing registry lock rather than leaving it to each caller.
   */
  addDisposableWorktree(input: {
    repoPath: string
    worktreePath: string
    sha: string
  }): Promise<{ ok: true } | { ok: false; error: string }>

  /**
   * Discard a shard's tree. Never merged back — B8's edits are scratch, and
   * merging them would let a reviewer silently rewrite the code under review.
   *
   * Reports failure rather than throwing: a tree that will not go away is a
   * disk leak worth logging, but it must not fail a round whose review already
   * succeeded.
   */
  removeDisposableWorktree(input: {
    repoPath: string
    worktreePath: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
}
