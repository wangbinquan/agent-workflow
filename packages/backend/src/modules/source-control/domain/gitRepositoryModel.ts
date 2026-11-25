// RFC-593 — the pure parts of source-control's git repository operations, moved verbatim from `util/git.ts` (now
// `infrastructure/local/gitRepository.ts`): the fixed identity of the platform's internal commits, the provenance a
// materialized worktree records for its cleanup, and the submodule filter and order. No I/O; the application layer and the
// infrastructure both take them from here.

/**
 * RFC-130: a FIXED author/committer identity for the platform's INTERNAL git commits
 * — the iso full-state snapshots (`snapshotFullState`) and the merge-resolution /
 * shard-replacement trees (`commitTree`). These are implementation-detail objects, so
 * they must NEVER depend on the ambient git config: a task worktree cloned from a URL
 * inherits no `user.name`/`user.email`, and some CI runners (notably GitHub's ubuntu
 * image) also have no global identity AND cannot auto-detect one (no resolvable
 * user@host email) — so a bare `git commit-tree` there fails with "committer identity
 * unknown", which surfaced as `iso-setup-failed` on ubuntu-only. Injecting this env
 * makes those internal commits succeed regardless of the host/worktree git config.
 * (RFC auto commit&push prefers the task's own identity when the launch
 * supplied one; the workspace change publication falls back to THIS identity otherwise —
 * a URL/scratch worktree's cache-clone parent carries no local user.*, so
 * "inherit the ambient config" meant guaranteed failure on such hosts.)
 */
export const AW_INTERNAL_GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'agent-workflow',
  GIT_AUTHOR_EMAIL: 'agent-workflow@localhost',
  GIT_COMMITTER_NAME: 'agent-workflow',
  GIT_COMMITTER_EMAIL: 'agent-workflow@localhost',
}

/**
 * Git ownership captured around one successful `git worktree add`.
 *
 * `branchBefore` is the local branch ref before this launch (`null` when the
 * launch created it). `branchAfter` is the exact ref value after materialize.
 * Rollback uses those values as compare-and-swap operands, so a concurrent ref
 * writer is never overwritten or force-deleted.
 */
export interface WorktreeCleanupProvenance {
  repoPath: string
  worktreePath: string
  branch: string
  branchRef: string
  branchBefore: string | null
  branchAfter: string
}

/**
 * Submodules that are actually usable — '-' (uninitialized) has no working dir.
 * RFC-475: moved from `services/gitSubmodule.ts` so platform isolation and the
 * source-control publication use case share one implementation; structural so
 * this leaf never imports a module's entry type.
 */
export function usableSubmodules<T extends { readonly flag: string }>(entries: readonly T[]): T[] {
  return entries.filter((e) => e.flag !== '-')
}

/** Bottom-up order: deepest paths first, so a child's gitlink bump is visible to its parent. */
export function bottomUp<T extends { readonly path: string; readonly pathDepth: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort((a, b) => b.pathDepth - a.pathDepth || b.path.localeCompare(a.path))
}
