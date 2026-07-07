// P-4-09: hourly worktree GC. Scans tasks whose status is terminal and
// applies the worktreeAutoGc thresholds:
//   - olderThanDays: skip if finishedAt is younger than threshold
//   - onlyMerged:    skip if the task branch is not merged into base
//                    (best-effort; we check with `git merge-base --is-ancestor`)
//
// Tasks themselves are NOT deleted — the row stays so users can see history;
// only the worktree directory on disk is removed.

import { inArray } from 'drizzle-orm'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TERMINAL_TASK_STATUSES, isTerminalTaskStatus } from '@agent-workflow/shared'
import type { Config, TaskStatus } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { deleteSnapshotRefs, removeWorktree, runGit } from '@/util/git'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'

const log = createLogger('gc')

const HOUR_MS = 60 * 60 * 1000

// flag-audit W0（dedup-audit `task-terminal-status-set` 同项）：终态集合改引
// shared 单源——此前是无 satisfies 守卫的裸字面量拷贝，TASK_STATUS 扩枚举时
// GC 会静默漏收。

export interface GcRunResult {
  scanned: number
  removed: string[]
  skipped: number
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
    .where(inArray(tasks.status, [...TERMINAL_TASK_STATUSES]))

  const result: GcRunResult = { scanned: candidates.length, removed: [], skipped: 0 }
  for (const t of candidates) {
    if (t.worktreePath === '' || !existsSync(t.worktreePath)) {
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
    if (onlyMerged) {
      const merged = await isMerged(t.worktreePath, t.baseBranch, t.branch)
      if (!merged) {
        result.skipped += 1
        continue
      }
    }
    try {
      await removeWorktree({ repoPath: t.repoPath, worktreePath: t.worktreePath, force: true })
      invalidateCallGraphIndex(t.worktreePath) // RFC-085 — free the cached class→file index
      // RFC-098 WP-9: the snapshot refs this task pinned in the source-repo
      // odb (refs/agent-workflow/snapshots/{taskId}/*) share the worktree's
      // lifecycle — retryNode/resumeTask can revive any terminal task while
      // its worktree exists, so this is the ONLY safe deletion point.
      // Single-repo only: multi-repo container tasks are the gc.ts multi-repo
      // blindspot (audit ⑥ gap-3 family) and get their ref cleanup with that
      // fix. Best-effort (`runGit` never throws); a leftover ref merely keeps
      // a stash commit alive. Note the recorded trade-off: with worktreeAutoGc
      // disabled, refs are retained indefinitely.
      await deleteSnapshotRefs(t.repoPath, t.id)
      result.removed.push(t.id)
    } catch (err) {
      log.warn('removeWorktree failed', {
        taskId: t.id,
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
 * RFC-130 PR-E — GC orphan iso worktrees. A node run normally `discardNodeIso`s its
 * iso worktree on completion, but a crash between create + discard, a kept
 * conflict-human resolve-iso, or a daemon restart can leave `{appHome}/iso/{taskId}/*`
 * behind. For every TERMINAL task (and any iso dir with no task row — a deleted task),
 * ALL its iso worktrees are orphans (no active node run), so we remove the container
 * dir and prune the now-dangling `git worktree` registrations from the task's repo.
 * ACTIVE tasks are skipped (their iso worktrees may be in flight). Best-effort — a
 * removal failure is logged and retried next tick.
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
    }
  }
  return { scanned: taskDirs.length, removed }
}

/**
 * Start an hourly worktree-GC ticker. The supplied `loadConfig` is invoked
 * each tick so config changes take effect without daemon restart. `appHome` (when
 * given) also GCs orphan iso worktrees (RFC-130 PR-E) each tick.
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
