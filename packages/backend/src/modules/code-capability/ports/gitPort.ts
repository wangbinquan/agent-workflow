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

  /**
   * RFC-304 T2c — freeze a worktree's current state as an immutable commit.
   *
   * The commit is what makes "push exactly what the human saw" possible. A
   * patch is posted, the human reads it, and some time later says yes; between
   * those two moments the agent's worktree is long gone and re-running the model
   * would produce a DIFFERENT change with the same justification. So the change
   * is committed at the moment it is shown, and confirmation pushes that object.
   *
   * `keepRef` is not optional bookkeeping: a commit reachable only from a
   * removed worktree's detached HEAD is unreferenced, and `git gc` may prune it
   * between the diff being posted and the reply arriving — which on a busy
   * repository is a real window, not a theoretical one.
   */
  commitWorktree(input: {
    repoPath: string
    worktreePath: string
    message: string
    /** Ref that keeps the commit alive, e.g. `refs/aw/artifacts/<id>`. */
    keepRef: string
    authorName?: string
    authorEmail?: string
  }): Promise<
    | { ok: true; commitSha: string }
    /** Nothing was changed in the worktree — not an error, just no artifact. */
    | { ok: false; reason: 'no-changes' }
    | { ok: false; reason: 'failed'; error: string }
  >

  /** The unified diff a frozen commit introduces, for posting and for digesting. */
  readCommitDiff(input: {
    repoPath: string
    commitSha: string
  }): Promise<{ ok: true; diff: string } | { ok: false; error: string }>

  /**
   * What an agent has changed in a worktree, before anything is committed.
   *
   * Read rather than frozen at this point on purpose: `decide-form` needs the
   * diff to choose between a suggestion and a patch, and only the patch path
   * needs a commit. Freezing first would mint an artifact — with a keep-alive
   * ref pinning a commit — for every suggestion too, and each would then have
   * to be released again to avoid leaking it.
   *
   * Untracked files are included: an agent's fix routinely adds one, and a diff
   * that silently omitted it would show a change that does not build.
   */
  readWorktreeDiff(input: {
    worktreePath: string
  }): Promise<{ ok: true; diff: string } | { ok: false; error: string }>

  /**
   * Push a frozen commit onto a branch at the remote.
   *
   * `expectedRemoteSha` makes it a compare-and-swap: the push is refused if the
   * branch has moved, rather than force-updating over whatever arrived while
   * the platform was waiting for a human (C7). Without it, "verify then push"
   * is a TOCTOU with a human-sized window in the middle.
   */
  pushCommit(input: {
    repoPath: string
    commitSha: string
    branch: string
    expectedRemoteSha: string
  }): Promise<
    | { ok: true }
    /** The remote moved between the check and the push. */
    | { ok: false; reason: 'stale'; error: string }
    | { ok: false; reason: 'failed'; error: string }
  >

  /** Drop a keep-alive ref so the object becomes collectable again. */
  deleteRef(input: {
    repoPath: string
    ref: string
  }): Promise<{ ok: true } | { ok: false; error: string }>
}
