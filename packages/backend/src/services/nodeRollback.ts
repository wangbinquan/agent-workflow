// RFC-092 T1 — shared node-run worktree rollback (audit S-2 / S-2b / S-13).
//
// Single authority for "roll a node_run's worktree(s) back to its pre-snapshot",
// extracted from task.ts `rollbackNodeRunForResume` so the scheduler's in-process
// retry path stops re-implementing it against the wrong column (S-2: multi-repo
// snapshots live in `pre_snapshot_repos_json`, the old retry path read only
// `pre_snapshot` and then ran git against the multi-repo CONTAINER directory).
//
// Two calling modes, switched by `resetOnEmptySnapshot`:
//   - false (resume / out-of-band): an empty or missing stash sha means "nothing
//     recorded — do not touch the worktree". Byte-compatible with the historical
//     resume behavior (task.ts) including the legacy multi-repo fallback: a
//     multi-repo run row with preSnapshotReposJson === null predates RFC-066
//     PR-B and falls through to the single-string rollback as a last-ditch
//     attempt.
//   - true (in-process retry): an empty sha still rolls back ('' makes
//     rollbackToSnapshot reset --hard + clean -fd, clearing the failed
//     attempt's partial writes — see scheduler-boundary-presnapshot-rollback-
//     skip.test.ts). Multi-repo HARD GATE: the container directory is never
//     touched; a missing/unparseable map degrades to a per-sub-repo '' reset,
//     not a container rollback (RFC-092 design §2.1).
//
// Per-repo errors are warn-and-continue; callers decide what to do next.

import { rollbackToSnapshot } from '@/util/git'
import type { Logger } from '@/util/log'

export interface RollbackTarget {
  repoCount: number
  /** Single-repo worktree; for multi-repo this is the container dir (never rolled back in retry mode). */
  worktreePath: string
  repos: Array<{ worktreePath: string; worktreeDirName: string }>
}

export interface RollbackRunRow {
  id: string
  preSnapshot: string | null
  preSnapshotReposJson: string | null
}

export async function rollbackNodeRunWorktrees(
  target: RollbackTarget,
  run: RollbackRunRow,
  opts: { resetOnEmptySnapshot: boolean },
  log: Logger,
): Promise<void> {
  const multiRepo = target.repoCount > 1 && target.repos.length > 0
  // Multi-repo branch. In resume mode (`resetOnEmptySnapshot: false`) it is
  // entered only when a per-repo map exists — a null map is a legacy pre-PR-B
  // row and falls through to the single-string path below (historical resume
  // semantics). In retry mode it is entered unconditionally: the container dir
  // must never see git commands, so even a missing map resolves to per-sub-repo
  // '' resets.
  if (multiRepo && (run.preSnapshotReposJson !== null || opts.resetOnEmptySnapshot)) {
    let map: Record<string, string> = {}
    if (run.preSnapshotReposJson !== null) {
      try {
        map = JSON.parse(run.preSnapshotReposJson) as Record<string, string>
      } catch (err) {
        // An unparseable map yields an empty one: every repo reads sha='' and
        // (in resume mode) is skipped — the historical outcome. The old task.ts
        // comment claimed this "falls through to the single-repo path"; the
        // control flow never did (the per-repo loop returns), so the shared
        // function encodes the REAL semantics. RFC-092 design §2.1.
        log.warn('preSnapshotReposJson parse failed; treating as empty per-repo map', {
          nodeRunId: run.id,
          error: err instanceof Error ? err.message : String(err),
        })
        map = {}
      }
    }
    for (const repo of target.repos) {
      const sha = map[repo.worktreeDirName] ?? ''
      if (sha === '' && !opts.resetOnEmptySnapshot) continue
      try {
        await rollbackToSnapshot(repo.worktreePath, sha)
      } catch (err) {
        log.warn('node-run rollback per-repo failed', {
          nodeRunId: run.id,
          worktreeDirName: repo.worktreeDirName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return
  }

  // Single-repo path (also the legacy multi-repo resume fallback when the
  // per-repo map is absent). Byte-baseline equivalent to pre-RFC-092 task.ts.
  if (target.worktreePath === '') return
  const snap = run.preSnapshot ?? ''
  if (snap === '' && !opts.resetOnEmptySnapshot) return
  try {
    await rollbackToSnapshot(target.worktreePath, snap)
  } catch (err) {
    log.warn('node-run rollback failed', {
      nodeRunId: run.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
