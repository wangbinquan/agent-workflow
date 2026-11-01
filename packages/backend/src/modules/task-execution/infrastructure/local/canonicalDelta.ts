// RFC-414 — the canonical delta behind the zero-delta-done warning (RFC-187 §4), moved verbatim from the node execution
// hooks in composition/nodeExecution.ts.
import { worktreeFilesChanged } from '@/util/git'

/**
 * RFC-187 §4 — canonical delta for the zero-delta-done warn. Throws (engine swallows) when there's no base commit to
 * diff against.
 *
 * RFC-187 §4 (Codex impl-gate P1) — sum the delta over EVERY canonical repo at its own worktree/base. The old form
 * diffed `task.worktreePath`, which for a multi-repo task is a NON-git parent container: git threw,
 * `warnIfZeroDeltaDone` swallowed it, and the zero-delta warning silently never fired for multi-repo tasks at all.
 * Single-repo is unchanged (repos[0].worktreePath === task.worktreePath).
 */
export async function countCanonicalFilesChanged(
  repos: ReadonlyArray<{ readonly worktreePath: string; readonly baseCommit: string | null }>,
): Promise<number> {
  const diffable = repos.filter((r) => r.baseCommit !== null)
  if (diffable.length === 0) {
    throw new Error('no base commit on any repo — cannot compute canonical delta')
  }
  const perRepo = await Promise.all(
    diffable.map((r) => worktreeFilesChanged(r.worktreePath, r.baseCommit as string)),
  )
  return perRepo.reduce((sum, n) => sum + n, 0)
}
