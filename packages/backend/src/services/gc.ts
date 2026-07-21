// P-4-09: hourly worktree GC. Scans tasks whose status is terminal and
// applies the worktreeAutoGc thresholds:
//   - olderThanDays: skip if finishedAt is younger than threshold
//   - onlyMerged:    skip if the task branch is not merged into base
//                    (multi-repo: EVERY task_repos row must be merged — RFC-165
//                    D3 closed the "top-level mirror only" blindspot; scratch
//                    spaces ignore onlyMerged, age is their only threshold)
//
// RFC-165 (F8/R3-1): deletion is a TWO-PHASE tombstone, not check→delete —
//   1. CLAIM: conditional UPDATE stamps `workspace_pruning_at` (wins only if
//      the task is still terminal and unclaimed; a stale claim past
//      PRUNING_LEASE_MS may be re-claimed so a crashed delete retries).
//   2. DELETE the directory (multi-repo: per task_repos row, then the parent
//      container; scratch: plain recursive rm — the workspace IS the repo, no
//      `git worktree remove` / snapshot-ref dance applies).
//   3. FINALIZE: stamp `workspace_pruned_at` only after the delete succeeded.
// Every revive path (resume / retry / sync-workflow / lifecycle repair / boot
// auto-resume) CAS-es task status with `pruning IS NULL AND pruned IS NULL`
// (services/lifecycle.ts setTaskStatus revival gate), so the
// claim↔revive race has exactly one winner.
//
// Tasks themselves are NOT deleted — the row stays so users can see history;
// only the workspace directory on disk is removed. `space_kind='internal'`
// tasks (fusion) are NEVER candidates: their dirs feed the approval flow
// (RFC-165 R3-4).

import { and, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_TASK_STATUSES, isTerminalTaskStatus } from '@agent-workflow/shared'
import type { Config, TaskStatus } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { taskRepos, tasks } from '@/db/schema'
import { deleteSnapshotRefs, removeWorktree, runGit } from '@/util/git'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'

const log = createLogger('gc')

const HOUR_MS = 60 * 60 * 1000

/** RFC-165 (R3-1): a pruning claim older than this is considered crashed and
 *  may be re-claimed by a later GC tick to finish the delete. */
export const PRUNING_LEASE_MS = 30 * 60 * 1000

/** RFC-165 (F9): scratch-orphan dirs younger than this are never reaped even
 *  without a lease — belt-and-suspenders for a daemon that restarted mid-
 *  materialize (the in-process lease map died with the old process). */
export const SCRATCH_ORPHAN_MIN_AGE_MS = 24 * HOUR_MS

/**
 * RFC-165 (F9): in-process lease over spaces being materialized. startTask
 * registers BEFORE mkdir and releases in its finally AFTER the task row
 * committed (or the failure cleanup ran). The scratch orphan scan skips any
 * dir with an active lease — a slow materialize→insert window must not get
 * its workspace reaped from under it.
 */
export const materializingSpaces = new Map<string, { dir: string; startedAt: number }>()

// flag-audit W0（dedup-audit `task-terminal-status-set` 同项）：终态集合改引
// shared 单源——此前是无 satisfies 守卫的裸字面量拷贝，TASK_STATUS 扩枚举时
// GC 会静默漏收。

export interface GcRunResult {
  scanned: number
  removed: string[]
  skipped: number
}

/**
 * Phase-1 claim (RFC-165 F8): stamp `workspace_pruning_at` iff the task is
 * still terminal, not yet pruned, and not claimed (or the claim is stale past
 * the lease). Returns whether THIS caller owns the delete.
 */
async function claimWorkspacePrune(db: DbClient, taskId: string, now: number): Promise<boolean> {
  const updated = await db
    .update(tasks)
    .set({ workspacePruningAt: now })
    .where(
      and(
        eq(tasks.id, taskId),
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        isNull(tasks.workspacePrunedAt),
        or(isNull(tasks.workspacePruningAt), lt(tasks.workspacePruningAt, now - PRUNING_LEASE_MS)),
      ),
    )
    .returning({ id: tasks.id })
  return updated.length === 1
}

export async function runWorktreeGc(
  db: DbClient,
  config: Pick<Config, 'worktreeAutoGc'>,
  now: number = Date.now(),
): Promise<GcRunResult> {
  const gc = config.worktreeAutoGc
  if (!gc.enabled) return { scanned: 0, removed: [], skipped: 0 }

  const minAgeMs =
    typeof gc.olderThanDays === 'number' && gc.olderThanDays > 0
      ? gc.olderThanDays * 24 * HOUR_MS
      : 0
  const onlyMerged = gc.onlyMerged === true

  const candidates = await db
    .select()
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        // RFC-165 (R3-4): internal (fusion) workspaces feed the approval flow
        // and are never GC candidates. Already-pruned rows have nothing to do.
        ne(tasks.spaceKind, 'internal'),
        isNull(tasks.workspacePrunedAt),
      ),
    )

  const result: GcRunResult = { scanned: candidates.length, removed: [], skipped: 0 }
  for (const t of candidates) {
    if (t.worktreePath === '' || !existsSync(t.worktreePath)) {
      // Legacy pre-tombstone GC (or manual rm) already took the dir — heal the
      // row forward so revive paths 410 instead of resurrecting a ghost
      // (R3-2-r4; boot reconcile does the same sweep once at startup).
      // Deliberately does NOT require workspacePruningAt to be null
      // (implementation-gate P2 fix): a daemon that died between deleting the
      // dir (phase 2) and stamping workspacePrunedAt (phase 3) leaves a
      // claimed row whose dir is gone — finalizing it here IS the crash
      // recovery; racing a live phase-3 stamp is idempotent (same tombstone).
      if (t.worktreePath !== '') {
        await db
          .update(tasks)
          .set({ workspacePrunedAt: now })
          .where(and(eq(tasks.id, t.id), isNull(tasks.workspacePrunedAt)))
      }
      result.skipped += 1
      continue
    }
    if (minAgeMs > 0) {
      const finished = t.finishedAt ?? t.startedAt
      if (now - finished < minAgeMs) {
        result.skipped += 1
        continue
      }
    }
    // RFC-165 (D3): merged-ness by space kind. Scratch has no base to merge
    // into — age is its only threshold. Multi-repo requires EVERY task_repos
    // row merged (checking only the repo-0 mirror could delete an unmerged
    // sibling; checking only the container path made multi-repo永 skip).
    if (onlyMerged && t.spaceKind !== 'scratch') {
      if (t.repoCount > 1) {
        const rows = await db.select().from(taskRepos).where(eq(taskRepos.taskId, t.id))
        let allMerged = rows.length > 0
        for (const r of rows) {
          if (!(await isMerged(r.worktreePath, r.baseBranch, r.branch))) {
            allMerged = false
            break
          }
        }
        if (!allMerged) {
          result.skipped += 1
          continue
        }
      } else if (!(await isMerged(t.worktreePath, t.baseBranch, t.branch))) {
        result.skipped += 1
        continue
      }
    }
    // Phase 1 — claim. Losing means a concurrent claimer owns it, the task
    // was revived (status left the terminal set), or it got pruned meanwhile.
    if (!(await claimWorkspacePrune(db, t.id, now))) {
      result.skipped += 1
      continue
    }
    // Phase 2 — delete (by space kind). Failure keeps the claim; the lease
    // expiry lets a later tick re-claim and finish (sustains the pre-165
    // "failed remove retries next tick" behavior without a permanent 410).
    try {
      if (t.spaceKind === 'scratch') {
        // The workspace IS the repo — no parent worktree registration, no
        // snapshot refs outside it. Plain recursive rm is complete.
        rmSync(t.worktreePath, { recursive: true, force: true })
        invalidateCallGraphIndex(t.worktreePath)
      } else if (t.repoCount > 1) {
        // RFC-165 (R3-1): per-repo teardown, then the parent container. Each
        // step tolerates an already-missing path so a crashed prior attempt
        // resumes cleanly after re-claim.
        const rows = await db.select().from(taskRepos).where(eq(taskRepos.taskId, t.id))
        for (const r of rows) {
          if (r.worktreePath !== '' && existsSync(r.worktreePath)) {
            await removeWorktree({
              repoPath: r.repoPath,
              worktreePath: r.worktreePath,
              force: true,
            })
            invalidateCallGraphIndex(r.worktreePath)
          }
          await deleteSnapshotRefs(r.repoPath, t.id)
        }
        rmSync(t.worktreePath, { recursive: true, force: true })
      } else {
        await removeWorktree({ repoPath: t.repoPath, worktreePath: t.worktreePath, force: true })
        invalidateCallGraphIndex(t.worktreePath) // RFC-085 — free the cached class→file index
        // RFC-098 WP-9: the snapshot refs this task pinned in the source-repo
        // odb (refs/agent-workflow/snapshots/{taskId}/*) share the worktree's
        // lifecycle — retryNode/resumeTask can revive any terminal task while
        // its worktree exists, so this is the ONLY safe deletion point.
        await deleteSnapshotRefs(t.repoPath, t.id)
      }
      // Phase 3 — finalize the tombstone. Revive paths now 410 deterministically.
      await db.update(tasks).set({ workspacePrunedAt: now }).where(eq(tasks.id, t.id))
      result.removed.push(t.id)
    } catch (err) {
      log.warn('workspace prune failed (claim kept; lease expiry retries)', {
        taskId: t.id,
        spaceKind: t.spaceKind,
        error: err instanceof Error ? err.message : String(err),
      })
      result.skipped += 1
    }
  }
  return result
}

async function isMerged(
  worktreePath: string,
  baseBranch: string,
  branch: string,
): Promise<boolean> {
  try {
    const r = await runGit(worktreePath, ['merge-base', '--is-ancestor', branch, baseBranch])
    return r.exitCode === 0
  } catch {
    return false
  }
}

/**
 * RFC-165 (R3-2-r4): one-shot boot reconcile — terminal tasks whose workspace
 * disappeared before the tombstone columns existed (old GC deleted dirs
 * without stamping anything) get `workspace_pruned_at` backfilled so every
 * revive path 410s deterministically instead of resurrecting a ghost.
 * Runs after migrations and BEFORE the HTTP server starts serving.
 */
export async function reconcileLegacyPrunedWorkspaces(db: DbClient): Promise<number> {
  const rows = await db
    .select({ id: tasks.id, worktreePath: tasks.worktreePath })
    .from(tasks)
    .where(
      and(
        inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
        isNull(tasks.workspacePrunedAt),
        isNull(tasks.workspacePruningAt),
        ne(tasks.worktreePath, ''),
      ),
    )
  const now = Date.now()
  let healed = 0
  for (const r of rows) {
    if (existsSync(r.worktreePath)) continue
    await db
      .update(tasks)
      .set({ workspacePrunedAt: now })
      .where(
        and(eq(tasks.id, r.id), isNull(tasks.workspacePruningAt), isNull(tasks.workspacePrunedAt)),
      )
    healed += 1
  }
  if (healed > 0) log.info('reconciled legacy pruned workspaces', { healed })
  return healed
}

/**
 * RFC-165 (F9): reap scratch dirs that no task row anchors — a crash between
 * materialize and INSERT leaves one behind. Two guards keep live launches
 * safe: the in-process `materializingSpaces` lease (registered before mkdir)
 * and a 24h age floor (covers a restart that wiped the lease map).
 */
export async function runScratchOrphanGc(
  db: DbClient,
  appHome: string,
  now: number = Date.now(),
): Promise<{ scanned: number; removed: string[] }> {
  const scratchRoot = join(appHome, 'scratch')
  if (!existsSync(scratchRoot)) return { scanned: 0, removed: [] }
  const dirs = readdirSync(scratchRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  if (dirs.length === 0) return { scanned: 0, removed: [] }
  const rows = await db.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, dirs))
  const anchored = new Set(rows.map((r) => r.id))
  const leased = new Set([...materializingSpaces.keys()])
  const removed: string[] = []
  for (const name of dirs) {
    if (anchored.has(name) || leased.has(name)) continue
    const full = join(scratchRoot, name)
    try {
      const age = now - statSync(full).mtimeMs
      if (age < SCRATCH_ORPHAN_MIN_AGE_MS) continue
      rmSync(full, { recursive: true, force: true })
      removed.push(name)
    } catch (err) {
      log.warn('scratch orphan reap failed', {
        dir: name,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { scanned: dirs.length, removed }
}

/**
 * RFC-130 PR-E — GC orphan iso worktrees. A node run normally `discardNodeIso`s its
 * iso worktree on completion, but a crash between create + discard, a kept
 * conflict-human resolve-iso, or a daemon restart can leave `{appHome}/iso/{taskId}/*`
 * behind. For every TERMINAL task (and any iso dir with no task row — a deleted task),
 * ALL its iso worktrees are orphans (no active node run), so we remove the container
 * dir and prune the now-dangling `git worktree` registrations from the task's repo.
 * ACTIVE tasks are skipped (their iso worktrees may be in flight).
 *
 * RFC-165 (D1): deleting a row-anchored container now rides the SAME per-task
 * pruning claim as the workspace GC — a transient stamp on
 * `workspace_pruning_at` blocks every revive CAS for the few ms the delete
 * takes, closing the "query snapshot → task revived → new in-flight iso →
 * stale GC deletes it" race. Tasks whose workspace is already tombstoned
 * (`workspace_pruned_at` set) delete freely — no revival is possible.
 */
export async function runIsoWorktreeGc(
  db: DbClient,
  appHome: string,
): Promise<{ scanned: number; removed: string[] }> {
  const isoRoot = join(appHome, 'iso')
  if (!existsSync(isoRoot)) return { scanned: 0, removed: [] }
  const taskDirs = readdirSync(isoRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  if (taskDirs.length === 0) return { scanned: 0, removed: [] }
  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      repoPath: tasks.repoPath,
      worktreePath: tasks.worktreePath,
      workspacePruningAt: tasks.workspacePruningAt,
      workspacePrunedAt: tasks.workspacePrunedAt,
    })
    .from(tasks)
    .where(inArray(tasks.id, taskDirs))
  const byId = new Map(rows.map((r) => [r.id, r]))
  const removed: string[] = []
  for (const taskId of taskDirs) {
    const t = byId.get(taskId)
    // Skip a task that still has a row and is NOT terminal — its iso may be in flight.
    if (t !== undefined && !isTerminalTaskStatus(t.status as TaskStatus)) {
      continue
    }
    const containerRoot = join(isoRoot, taskId)
    // RFC-165 (D1): row-anchored + revivable → take the transient claim.
    // Tombstoned or row-less containers delete without ceremony.
    let claimStamp: number | null = null
    if (t !== undefined && t.workspacePrunedAt === null) {
      claimStamp = Date.now()
      const claimed = await db
        .update(tasks)
        .set({ workspacePruningAt: claimStamp })
        .where(
          and(
            eq(tasks.id, taskId),
            inArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
            isNull(tasks.workspacePruningAt),
            isNull(tasks.workspacePrunedAt),
          ),
        )
        .returning({ id: tasks.id })
      if (claimed.length !== 1) {
        // Revived, being pruned by workspace GC, or racing another claimer —
        // leave the container for the next tick.
        continue
      }
    }
    try {
      rmSync(containerRoot, { recursive: true, force: true })
      // Prune the now-dangling worktree registrations from the task's repo/worktree.
      if (t !== undefined) {
        for (const wt of [t.worktreePath, t.repoPath]) {
          if (wt !== '' && existsSync(wt)) {
            await runGit(wt, ['worktree', 'prune']).catch(() => {})
          }
        }
      }
      removed.push(taskId)
    } catch (err) {
      log.warn('iso worktree GC failed', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // Release the transient claim (CAS-scoped: only OUR stamp, and only if
      // the workspace GC didn't finalize a tombstone meanwhile).
      if (claimStamp !== null) {
        await db
          .update(tasks)
          .set({ workspacePruningAt: null })
          .where(
            and(
              eq(tasks.id, taskId),
              eq(tasks.workspacePruningAt, claimStamp),
              isNull(tasks.workspacePrunedAt),
            ),
          )
      }
    }
  }
  return { scanned: taskDirs.length, removed }
}

/**
 * Start an hourly worktree-GC ticker. The supplied `loadConfig` is invoked
 * each tick so config changes take effect without daemon restart. `appHome` (when
 * given) also GCs orphan iso worktrees (RFC-130 PR-E) and orphan scratch dirs
 * (RFC-165 F9) each tick.
 */
export function startWorktreeGc(
  db: DbClient,
  loadConfig: () => Pick<Config, 'worktreeAutoGc'>,
  intervalMs: number = HOUR_MS,
  appHome?: string,
): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    runWorktreeGc(db, loadConfig())
      .then(() => (appHome !== undefined ? runIsoWorktreeGc(db, appHome) : undefined))
      .then(() => (appHome !== undefined ? runScratchOrphanGc(db, appHome) : undefined))
      .catch((err: unknown) => {
        log.error('runWorktreeGc failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return { stop: () => clearInterval(handle) }
}
