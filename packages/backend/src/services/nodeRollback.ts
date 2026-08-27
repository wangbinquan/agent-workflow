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

import { gitCommitExists, rollbackToSnapshot } from '@/util/git'
import type { Logger } from '@/util/log'
import { sha256Hex } from '@/util/hash'
import { asc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { taskRepos, tasks } from '@/db/schema'
import { createLocalEffectAttemptObserver } from '@/services/taskExecutionParticipants'

export interface RollbackTarget {
  taskId?: string
  db?: DbClient
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

/** RFC-098 B1: per-repo rollback outcome. `attempted` = at least one worktree
 *  was actually rolled back; `failures` = per-repo errors (warn-and-continue
 *  semantics preserved — callers decide whether a failure escalates). */
export interface RollbackOutcome {
  attempted: boolean
  failures: Array<{ worktreeDirName?: string; code: string; message: string }>
}

export interface PlannedNodeRunRollbackTarget {
  worktreePath: string
  worktreeDirName: string
  snapshot: string
}

/**
 * RFC-333 T8: resolve the exact worktree/snapshot pairs without touching the
 * worktree.  The legacy executor and the durable human-gate effect share this
 * shape so multi-repo fallback semantics cannot drift during the cutover.
 */
export function planNodeRunRollbackTargets(
  target: RollbackTarget,
  run: RollbackRunRow,
  opts: { resetOnEmptySnapshot: boolean },
): PlannedNodeRunRollbackTarget[] {
  const multiRepo = target.repoCount > 1 && target.repos.length > 0
  if (multiRepo && (run.preSnapshotReposJson !== null || opts.resetOnEmptySnapshot)) {
    let map: Record<string, string> = {}
    if (run.preSnapshotReposJson !== null) {
      try {
        const decoded: unknown = JSON.parse(run.preSnapshotReposJson)
        if (decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)) {
          map = decoded as Record<string, string>
        }
      } catch {
        // Preserve the historical malformed-map behavior: every repo resolves
        // to an empty snapshot (skip in resume mode, reset-only in retry mode).
      }
    }
    return target.repos.flatMap((repo) => {
      const snapshot = typeof map[repo.worktreeDirName] === 'string' ? map[repo.worktreeDirName]! : ''
      if (snapshot === '' && !opts.resetOnEmptySnapshot) return []
      return [{ ...repo, snapshot }]
    })
  }

  if (target.worktreePath === '') return []
  const snapshot = run.preSnapshot ?? ''
  if (snapshot === '' && !opts.resetOnEmptySnapshot) return []
  return [{ worktreePath: target.worktreePath, worktreeDirName: '', snapshot }]
}

/**
 * RFC-098 B1 (audit ⑥-10): load the RollbackTarget for a task — tasks row +
 * taskRepos (repoIndex order), with the same single-repo synthesized fallback
 * the scheduler uses for rows predating the multi-repo migration.
 */
export async function loadRollbackTarget(
  db: DbClient,
  taskId: string,
): Promise<RollbackTarget | null> {
  const taskRowArr = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1)
  const t = taskRowArr[0]
  if (t === undefined) return null
  const repoRows = await db
    .select()
    .from(taskRepos)
    .where(eq(taskRepos.taskId, taskId))
    .orderBy(asc(taskRepos.repoIndex))
  const repos =
    repoRows.length > 0
      ? repoRows.map((r) => ({ worktreePath: r.worktreePath, worktreeDirName: r.worktreeDirName }))
      : [{ worktreePath: t.worktreePath, worktreeDirName: '' }]
  return { taskId, db, repoCount: t.repoCount, worktreePath: t.worktreePath, repos }
}

export async function rollbackNodeRunWorktrees(
  target: RollbackTarget,
  run: RollbackRunRow,
  opts: {
    resetOnEmptySnapshot: boolean
    /**
     * RFC-108 T7 (AR-17): dry-run. Runs the same fail-closed `gitCommitExists`
     * existence checks (populating `snapshot-missing` failures) but NEVER
     * touches a worktree. Used by resumeKick's cross-node-run pre-pass so a
     * LATER row's pruned snapshot is detected BEFORE any earlier row is reset.
     */
    checkOnly?: boolean
  },
  log: Logger,
): Promise<RollbackOutcome> {
  const outcome: RollbackOutcome = { attempted: false, failures: [] }
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
    // RFC-098 WP-9 (design 修订#3): two-phase all-or-nothing. Phase 1 verifies
    // every non-empty per-repo snapshot still resolves to a commit BEFORE any
    // repo is touched — the old single pass could destroy repo 1 (reset+clean)
    // and only then hit a gc-pruned snapshot on repo 2, violating the
    // fail-closed promise. '' repos skip the check (no snapshot object is
    // needed: they are skipped in resume mode / reset-only in retry mode).
    // Any missing snapshot → failures filled with 'snapshot-missing' and ZERO
    // repos touched (`attempted` stays false). rollbackToSnapshot keeps its
    // own head check as the direct-caller backstop.
    for (const repo of target.repos) {
      const sha = map[repo.worktreeDirName] ?? ''
      if (sha === '') continue
      if (!(await gitCommitExists(repo.worktreePath, sha))) {
        outcome.failures.push({
          worktreeDirName: repo.worktreeDirName,
          code: 'snapshot-missing',
          message: `snapshot ${sha} not found in the object database (pruned by gc?); no repo touched`,
        })
        log.warn('node-run rollback pre-check: per-repo snapshot missing', {
          nodeRunId: run.id,
          worktreeDirName: repo.worktreeDirName,
          sha,
        })
      }
    }
    if (outcome.failures.length > 0) return outcome
    // RFC-108 T7: dry-run stops here — existence verified, nothing reset.
    if (opts.checkOnly) return outcome

    const effect =
      target.taskId === undefined || target.db === undefined
        ? undefined
        : createLocalEffectAttemptObserver({
            db: target.db,
            taskId: target.taskId,
            nodeRunId: run.id,
            kind: 'workspace-rollback',
            stableActionOrdinal: 'workspace-rollback',
            candidateId: 'node-snapshot-rollback',
            request: { v: 1, runId: run.id, snapshots: map },
            resourceKeys: target.repos.map((repo) => `workspace:${sha256Hex(repo.worktreePath)}`),
          })
    await effect?.beforeAct()

    // Phase 2: every snapshot verified — execute the per-repo rollback.
    for (const repo of target.repos) {
      const sha = map[repo.worktreeDirName] ?? ''
      if (sha === '' && !opts.resetOnEmptySnapshot) continue
      try {
        await rollbackToSnapshot(repo.worktreePath, sha)
        outcome.attempted = true
      } catch (err) {
        outcome.failures.push({
          worktreeDirName: repo.worktreeDirName,
          code: (err as { code?: string }).code ?? 'rollback-failed',
          message: err instanceof Error ? err.message : String(err),
        })
        log.warn('node-run rollback per-repo failed', {
          nodeRunId: run.id,
          worktreeDirName: repo.worktreeDirName,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    if (outcome.failures.length === 0) {
      effect?.succeed({ attempted: outcome.attempted, repoCount: target.repos.length })
    } else {
      effect?.fail(new Error(outcome.failures.map((failure) => failure.message).join('; ')), {
        attempted: outcome.attempted,
        repoCount: target.repos.length,
      })
    }
    return outcome
  }

  // Single-repo path (also the legacy multi-repo resume fallback when the
  // per-repo map is absent). Byte-baseline equivalent to pre-RFC-092 task.ts.
  if (target.worktreePath === '') return outcome
  const snap = run.preSnapshot ?? ''
  if (snap === '' && !opts.resetOnEmptySnapshot) return outcome
  // RFC-108 T7: dry-run existence check (cross-row pre-pass) — verify the
  // snapshot resolves to a commit without touching the worktree. An empty snap
  // in retry mode ('' = reset-only) has no object to verify, so it never fails.
  if (opts.checkOnly) {
    if (snap !== '' && !(await gitCommitExists(target.worktreePath, snap))) {
      outcome.failures.push({
        code: 'snapshot-missing',
        message: `snapshot ${snap} not found in the object database (pruned by gc?); no repo touched`,
      })
    }
    return outcome
  }
  const effect =
    target.taskId === undefined || target.db === undefined
      ? undefined
      : createLocalEffectAttemptObserver({
          db: target.db,
          taskId: target.taskId,
          nodeRunId: run.id,
          kind: 'workspace-rollback',
          stableActionOrdinal: 'workspace-rollback',
          candidateId: 'node-snapshot-rollback',
          request: { v: 1, runId: run.id, snapshot: snap },
          resourceKeys: [`workspace:${sha256Hex(target.worktreePath)}`],
        })
  await effect?.beforeAct()
  try {
    await rollbackToSnapshot(target.worktreePath, snap)
    outcome.attempted = true
  } catch (err) {
    outcome.failures.push({
      code: (err as { code?: string }).code ?? 'rollback-failed',
      message: err instanceof Error ? err.message : String(err),
    })
    log.warn('node-run rollback failed', {
      nodeRunId: run.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }
  if (outcome.failures.length === 0) {
    effect?.succeed({ attempted: outcome.attempted })
  } else {
    effect?.fail(new Error(outcome.failures.map((failure) => failure.message).join('; ')), {
      attempted: outcome.attempted,
    })
  }
  return outcome
}
