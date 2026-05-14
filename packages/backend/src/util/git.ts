// git CLI helpers used by repo endpoints, the runner, and worktree management.
//
// Shells out to `git` (we depend on >= 2.5 — checked in `doctor`). All output
// is line-parsed; no porcelain v2 / NUL-separated yet — paths with newlines
// will not survive lsFiles, which we accept as a v1 limitation.

import type { GitRef } from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'

export interface GitRunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run `git -C <cwd> <...args>` and capture stdout/stderr. Never throws. */
export async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  const proc = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

/** Throw a typed error if `repoPath` is not a usable git repo. */
export async function requireGitRepo(repoPath: string): Promise<void> {
  if (!existsSync(repoPath)) {
    throw new NotFoundError('repo-path-missing', `path does not exist: ${repoPath}`)
  }
  const r = await runGit(repoPath, ['rev-parse', '--git-dir'])
  if (r.exitCode !== 0) {
    throw new ValidationError('repo-not-git', `${repoPath} is not a git repository`, {
      stderr: r.stderr.trim(),
    })
  }
}

// -----------------------------------------------------------------------------
// Read-only queries used by /api/repos/* (P-1-10)
// -----------------------------------------------------------------------------

export async function listBranches(repoPath: string): Promise<string[]> {
  const r = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ])
  if (r.exitCode !== 0) return []
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
}

export async function listTags(repoPath: string): Promise<string[]> {
  const r = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/tags'])
  if (r.exitCode !== 0) return []
  return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s.length > 0)
}

export async function recentCommits(repoPath: string, count = 50): Promise<GitRef[]> {
  const r = await runGit(repoPath, ['log', `-${count}`, '--format=%H%x09%s'])
  if (r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, subject] = line.split('\t', 2)
      return { sha: sha ?? '', subject: subject ?? '' }
    })
}

export async function currentBranch(repoPath: string): Promise<string | null> {
  const r = await runGit(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (r.exitCode !== 0) return null
  const v = r.stdout.trim()
  return v === '' || v === 'HEAD' ? null : v
}

/**
 * Best-effort default branch detection. Prefers `origin/HEAD`; falls back to
 * common defaults if the symbolic ref isn't set up.
 */
export async function defaultBranch(repoPath: string): Promise<string | null> {
  const r = await runGit(repoPath, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (r.exitCode === 0) {
    const ref = r.stdout.trim() // e.g. 'origin/main'
    if (ref.length > 0) return ref.replace(/^origin\//, '')
  }
  const branches = await listBranches(repoPath)
  if (branches.includes('main')) return 'main'
  if (branches.includes('master')) return 'master'
  return null
}

export async function listFiles(repoPath: string): Promise<string[]> {
  const r = await runGit(repoPath, ['ls-files'])
  if (r.exitCode !== 0) {
    throw new DomainError('git-ls-files-failed', r.stderr.trim() || 'git ls-files failed', 500)
  }
  return r.stdout.split('\n').filter((s) => s.length > 0)
}

// -----------------------------------------------------------------------------
// Worktree management (P-1-12)
// -----------------------------------------------------------------------------

/**
 * Stable per-repo directory slug used under `~/.agent-workflow/worktrees/`.
 * `sha1(absPath).slice(0,8) + '-' + basename(absPath)` — readable yet unique.
 */
export function repoSlug(repoPath: string): string {
  const hash = createHash('sha1').update(repoPath).digest('hex').slice(0, 8)
  return `${hash}-${basename(repoPath)}`
}

export interface CreateWorktreeOptions {
  /** Absolute path to the source repo. */
  repoPath: string
  /** ULID of the task; used in both branch name and worktree path. */
  taskId: string
  /** Base ref to branch off. Defaults to repo HEAD. */
  baseBranch?: string
  /** App home (default ~/.agent-workflow) — used to compose the worktree path. */
  appHome: string
}

export interface CreatedWorktree {
  worktreePath: string
  branch: string
  /** Source-repo commit the worktree starts from (for snapshotting later). */
  baseCommit: string
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
  await requireGitRepo(opts.repoPath)
  const slug = repoSlug(opts.repoPath)
  const worktreePath = join(opts.appHome, 'worktrees', slug, opts.taskId)
  const branch = `agent-workflow/${opts.taskId}`

  // Pick base ref. Falls back to HEAD when caller didn't specify.
  const base = opts.baseBranch ?? (await currentBranch(opts.repoPath)) ?? 'HEAD'

  // Resolve to a concrete commit so the worktree is reproducible even if base
  // is a symbolic ref that moves underneath us.
  const baseRev = await runGit(opts.repoPath, ['rev-parse', base])
  if (baseRev.exitCode !== 0) {
    throw new ValidationError('worktree-base-invalid', `cannot resolve base ref '${base}'`, {
      stderr: baseRev.stderr.trim(),
    })
  }
  const baseCommit = baseRev.stdout.trim()

  const add = await runGit(opts.repoPath, [
    'worktree',
    'add',
    '-b',
    branch,
    worktreePath,
    baseCommit,
  ])
  if (add.exitCode !== 0) {
    throw new DomainError(
      'worktree-add-failed',
      `git worktree add failed: ${add.stderr.trim()}`,
      500,
    )
  }
  return { worktreePath, branch, baseCommit }
}

export interface RemoveWorktreeOptions {
  repoPath: string
  worktreePath: string
  /** Pass through `--force` (default false). */
  force?: boolean
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const args = ['worktree', 'remove', opts.worktreePath]
  if (opts.force) args.push('--force')
  const r = await runGit(opts.repoPath, args)
  if (r.exitCode !== 0) {
    throw new DomainError(
      'worktree-remove-failed',
      `git worktree remove failed: ${r.stderr.trim()}`,
      500,
    )
  }
}
