// RFC-304 — the git operations `prepare-worktree` needs, and nothing else.
//
// `util/git.ts` is large and does much more; a capability needs three verbs.
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
}
