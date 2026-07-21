// RFC-213 G4a — same-machine worktree capture + reconstruction.
//
// A plain DB restore reverts the DB but leaves worktrees as they are; a
// non-terminal task whose worktree was lost would come back as a
// worktree-missing `interrupted` zombie. This captures each non-terminal task's
// worktree working state (tracked changes + untracked, EXCLUDING .git) into the
// backup, and on restore reconstructs any worktree that is now MISSING so the
// user's in-flight work returns — for inspection / manual salvage.
//
// Deliberately does NOT touch the resume/rollback path: on resume a reconstructed
// worktree is rolled back to its pre_snapshot exactly like any other (that IS the
// correct resume semantics — a re-run must start from a clean pre-run state).
// The auto-resume-suspension applied by restore (services/restore.ts) keeps the
// user in control until they consciously resume. Same-machine only: the base
// commits / branch live in the cached mirror under ~/.agent-workflow/repos which
// the backup excludes.

import { eq, inArray } from 'drizzle-orm'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { extractTarGz, tarGz } from '@/util/archive'
import { runGit } from '@/util/git'
import { createLogger } from '@/util/log'

const log = createLogger('worktreeBackup')

const NON_TERMINAL_TASK_STATUSES = [
  'running',
  'pending',
  'awaiting_review',
  'awaiting_human',
  'interrupted',
]

/** Per-task worktree that exceeding this is skipped (recorded), not captured. */
export const DEFAULT_MAX_WORKTREE_BYTES = 64 * 1024 * 1024

interface WorktreeMeta {
  taskId: string
  worktreePath: string
  branch: string
  repoPath: string
  baseCommit: string | null
}

export interface WorktreeCaptureResult {
  captured: string[]
  skipped: { taskId: string; reason: string }[]
}

/** Bytes under `dir`, skipping a top-level `.git`. */
function dirSizeExclGit(dir: string): number {
  let total = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name === '.git') continue
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else {
        try {
          total += statSync(p).size
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  }
  return total
}

/**
 * Capture non-terminal tasks' worktrees into `${stagingDir}/worktrees/`. Each
 * becomes `<taskId>.tar.gz` (working tree minus .git) + `<taskId>.json` (meta).
 */
export async function captureWorktrees(
  db: DbClient,
  stagingDir: string,
  opts?: { maxBytes?: number },
): Promise<WorktreeCaptureResult> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_WORKTREE_BYTES
  const rows = db
    .select({
      id: tasks.id,
      worktreePath: tasks.worktreePath,
      branch: tasks.branch,
      repoPath: tasks.repoPath,
      baseCommit: tasks.baseCommit,
    })
    .from(tasks)
    .where(inArray(tasks.status, NON_TERMINAL_TASK_STATUSES as never))
    .all()

  const wtDir = join(stagingDir, 'worktrees')
  mkdirSync(wtDir, { recursive: true })
  const captured: string[] = []
  const skipped: { taskId: string; reason: string }[] = []

  for (const t of rows) {
    if (!existsSync(t.worktreePath)) {
      skipped.push({ taskId: t.id, reason: 'worktree missing on disk' })
      continue
    }
    const size = dirSizeExclGit(t.worktreePath)
    if (size > maxBytes) {
      skipped.push({ taskId: t.id, reason: `over cap (${size} > ${maxBytes} bytes)` })
      log.warn('worktree capture skipped (over cap)', { taskId: t.id, size, maxBytes })
      continue
    }
    const meta: WorktreeMeta = {
      taskId: t.id,
      worktreePath: t.worktreePath,
      branch: t.branch,
      repoPath: t.repoPath,
      baseCommit: t.baseCommit,
    }
    // Impl-gate P2-18: await the meta write (a floating promise turned an IO
    // error into an unhandled rejection instead of a caught skip).
    await Bun.write(join(wtDir, `${t.id}.json`), JSON.stringify(meta))
    // Impl-gate P2-7: one un-tarrable worktree (agent writing files mid-tar →
    // GNU tar "file changed as we read it", files vanishing) must SKIP that
    // task, not abort the whole backup — same skip-not-fail contract as the
    // size cap above. Drop the meta json so reconstruct never sees a
    // meta-without-tar orphan.
    try {
      await tarGz(t.worktreePath, join(wtDir, `${t.id}.tar.gz`), { exclude: ['.git'] })
    } catch (err) {
      // Drop BOTH halves: the meta json (reconstruct is json-driven) AND the
      // partial tar the failed run already flushed (a torn archive in the
      // backup would read as a capture that never happened).
      rmSync(join(wtDir, `${t.id}.json`), { force: true })
      rmSync(join(wtDir, `${t.id}.tar.gz`), { force: true })
      const reason = `tar failed: ${err instanceof Error ? err.message : String(err)}`
      skipped.push({ taskId: t.id, reason })
      log.warn('worktree capture skipped (tar failed)', { taskId: t.id, reason })
      continue
    }
    captured.push(t.id)
  }
  log.info('worktrees captured', { captured: captured.length, skipped: skipped.length })
  return { captured, skipped }
}

export interface WorktreeReconstructResult {
  reconstructed: string[]
  skipped: { taskId: string; reason: string }[]
}

/**
 * Reconstruct worktrees captured under `${extractedDir}/worktrees/` for tasks
 * that (a) still exist in the DB, (b) are non-terminal, and (c) whose worktree is
 * MISSING on disk. `git worktree add <path> <branch>` from the mirror, then
 * overlay the captured working state. Never overwrites an existing worktree.
 */
export async function reconstructWorktrees(
  db: DbClient,
  extractedDir: string,
): Promise<WorktreeReconstructResult> {
  const wtDir = join(extractedDir, 'worktrees')
  const reconstructed: string[] = []
  const skipped: { taskId: string; reason: string }[] = []
  let metaFiles: string[]
  try {
    metaFiles = readdirSync(wtDir).filter((f) => f.endsWith('.json'))
  } catch {
    return { reconstructed, skipped } // no worktrees captured
  }

  for (const mf of metaFiles) {
    let meta: WorktreeMeta
    try {
      meta = JSON.parse(await Bun.file(join(wtDir, mf)).text()) as WorktreeMeta
    } catch {
      continue
    }
    const row = db.select().from(tasks).where(eq(tasks.id, meta.taskId)).get()
    if (row === undefined) {
      skipped.push({ taskId: meta.taskId, reason: 'task no longer in DB' })
      continue
    }
    if (!NON_TERMINAL_TASK_STATUSES.includes(row.status)) {
      skipped.push({ taskId: meta.taskId, reason: `terminal (${row.status})` })
      continue
    }
    if (existsSync(meta.worktreePath)) {
      skipped.push({ taskId: meta.taskId, reason: 'worktree already present (not overwritten)' })
      continue
    }
    const tarball = join(wtDir, `${meta.taskId}.tar.gz`)
    if (!existsSync(tarball)) {
      skipped.push({ taskId: meta.taskId, reason: 'captured tarball missing' })
      continue
    }
    if (!existsSync(meta.repoPath)) {
      skipped.push({ taskId: meta.taskId, reason: 'source mirror gone (cross-machine?)' })
      continue
    }
    // Clear any stale worktree registration, then re-create + overlay.
    await runGit(meta.repoPath, ['worktree', 'prune'])
    const add = await runGit(meta.repoPath, ['worktree', 'add', meta.worktreePath, meta.branch])
    if (add.exitCode !== 0) {
      skipped.push({ taskId: meta.taskId, reason: `worktree add failed: ${add.stderr.trim()}` })
      log.warn('worktree reconstruct failed', { taskId: meta.taskId, error: add.stderr.trim() })
      continue
    }
    await extractTarGz(tarball, meta.worktreePath)
    reconstructed.push(meta.taskId)
  }
  log.info('worktrees reconstructed', {
    reconstructed: reconstructed.length,
    skipped: skipped.length,
  })
  return { reconstructed, skipped }
}
