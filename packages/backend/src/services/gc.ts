// P-4-09: hourly worktree GC. Scans tasks whose status is terminal and
// applies the worktreeAutoGc thresholds:
//   - olderThanDays: skip if finishedAt is younger than threshold
//   - onlyMerged:    skip if the task branch is not merged into base
//                    (best-effort; we check with `git merge-base --is-ancestor`)
//
// Tasks themselves are NOT deleted — the row stays so users can see history;
// only the worktree directory on disk is removed.

import { inArray } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { deleteSnapshotRefs, removeWorktree, runGit } from '@/util/git'
import { invalidateCallGraphIndex } from '@/services/structuralDiff/callGraph/expandService'
import { createLogger } from '@/util/log'

const log = createLogger('gc')

const HOUR_MS = 60 * 60 * 1000

const TERMINAL_STATUSES: Array<'done' | 'failed' | 'canceled' | 'interrupted'> = [
  'done',
  'failed',
  'canceled',
  'interrupted',
]

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

  const candidates = await db.select().from(tasks).where(inArray(tasks.status, TERMINAL_STATUSES))

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
 * Start an hourly worktree-GC ticker. The supplied `loadConfig` is invoked
 * each tick so config changes take effect without daemon restart.
 */
export function startWorktreeGc(
  db: DbClient,
  loadConfig: () => Pick<Config, 'worktreeAutoGc'>,
  intervalMs: number = HOUR_MS,
): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    runWorktreeGc(db, loadConfig())
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
