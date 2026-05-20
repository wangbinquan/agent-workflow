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

/**
 * Non-interactive env for any `git` spawn. Without these, ssh reads `/dev/tty`
 * directly (not stdin) on first connect to an unknown host and hangs the daemon
 * forever — closing stdin doesn't help. Two ssh options + one git option fix it:
 *   - BatchMode=yes — ssh fails fast instead of prompting on tty for any input.
 *   - StrictHostKeyChecking=accept-new — TOFU new hosts into known_hosts but
 *     still reject when a known host's fingerprint changes (MITM defense).
 *   - GIT_TERMINAL_PROMPT=0 — same treatment for HTTPS credential prompts.
 */
export function nonInteractiveGitEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    GIT_SSH_COMMAND: [
      process.env.GIT_SSH_COMMAND ?? 'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ].join(' '),
    GIT_TERMINAL_PROMPT: '0',
  }
}

/** Run `git -C <cwd> <...args>` and capture stdout/stderr. Never throws. */
export async function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  const proc = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    // Explicit env passthrough — Bun.spawn under `bun test` does not pick up
    // post-startup process.env mutations otherwise, which makes per-test env
    // injection (e.g. GIT_CONFIG_GLOBAL) unreliable. In production this is a
    // no-op since process.env is fixed at daemon start.
    env: nonInteractiveGitEnv(),
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
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export async function listTags(repoPath: string): Promise<string[]> {
  const r = await runGit(repoPath, ['for-each-ref', '--format=%(refname:short)', 'refs/tags'])
  if (r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
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
  /**
   * RFC-034: behavior for the post-`worktree add` `submodule update --init`
   * pass. Defaults to 'auto' (init when `.gitmodules` is present in the parent
   * repo). Caller (services/task.ts startTask) wires this through from
   * settings.gitRecurseSubmodules.
   */
  submoduleMode?: 'auto' | 'always' | 'never'
  /** RFC-034: --jobs N for the submodule init. Defaults to 4. */
  submoduleJobs?: number
}

export interface CreatedWorktree {
  worktreePath: string
  branch: string
  /** Source-repo commit the worktree starts from (for snapshotting later). */
  baseCommit: string
  /**
   * RFC-034: outcome of the `submodule update --init --recursive` pass on the
   * fresh worktree. `true` when no submodules / mode='never' / sync succeeded.
   * `false` indicates a partial init — caller should emit a warning event but
   * MUST NOT fail the task launch (submodule access is often the user's
   * responsibility, not the framework's).
   */
  submoduleInitOk: boolean
  /** Redacted stderr from a failed submodule init, or null. */
  submoduleInitError: string | null
  /** True iff the parent repo carries a `.gitmodules` file. */
  hasSubmodules: boolean
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

  // RFC-034: dynamic import to avoid a circular dep between util/git.ts and
  // services/gitSubmodule.ts (which itself imports runGit from this file).
  const { syncSubmodules } = await import('@/services/gitSubmodule')
  const { resolveSubmoduleParams } = await import('@/services/gitRepoCache')
  const effective = resolveSubmoduleParams(opts.submoduleMode, opts.submoduleJobs)
  const sub = await syncSubmodules(worktreePath, {
    mode: effective.mode,
    jobs: effective.jobs,
  })

  return {
    worktreePath,
    branch,
    baseCommit,
    submoduleInitOk: sub.ok,
    submoduleInitError: sub.error,
    hasSubmodules: sub.hasGitmodules,
  }
}

/**
 * Cumulative diff between the worktree and `fromCommit`, including uncommitted
 * changes and untracked files. Empty string when nothing has changed.
 *
 * Internally uses `git -c core.quotepath=false diff --binary <fromCommit> --`
 * plus `git ls-files --others --exclude-standard` for untracked files
 * (each rendered as a synthetic add diff via `git diff --no-index /dev/null
 * <path>`). The combined output is a self-contained unified diff that
 * `parseDiff()` in `util/diffSplit.ts` can shard.
 */
export async function gitDiffSnapshot(worktreePath: string, fromCommit: string): Promise<string> {
  const tracked = await runGit(worktreePath, [
    '-c',
    'core.quotepath=false',
    'diff',
    fromCommit,
    '--',
  ])
  if (tracked.exitCode !== 0) {
    throw new DomainError('worktree-diff-failed', `git diff failed: ${tracked.stderr.trim()}`, 500)
  }
  // `core.quotepath=false` is critical: without it, ls-files C-style escapes
  // any non-ASCII path (e.g. `docs/中文.md` -> `"docs/\344\270\255\346\226\207.md"`)
  // and the loop below feeds that quoted/escaped string back to `git diff
  // --no-index`, which fails with `Could not access ...` and silently drops
  // the file from the diff.
  const untrackedList = await runGit(worktreePath, [
    '-c',
    'core.quotepath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
  ])
  const untrackedNames = untrackedList.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  let untrackedDiff = ''
  for (const name of untrackedNames) {
    const one = await runGit(worktreePath, [
      '-c',
      'core.quotepath=false',
      'diff',
      '--no-index',
      '--binary',
      '--',
      '/dev/null',
      name,
    ])
    // `git diff --no-index` exits 0 when files are identical, 1 when they
    // differ (the expected case here, since we diff against /dev/null), and
    // >1 on a real error like "Could not access". Treat anything beyond 0/1
    // as fatal so a future regression can't silently swallow untracked files.
    if (one.exitCode > 1) {
      throw new DomainError(
        'worktree-diff-failed',
        `git diff --no-index failed for untracked path ${name}: ${one.stderr.trim()}`,
        500,
      )
    }
    untrackedDiff += one.stdout
  }

  // Avoid emitting a leading blank line when only untracked files changed.
  // The frontend DiffViewer buckets any line before the first `diff --git`
  // marker into a virtual `(preamble)` block; a stray `\n` would surface as
  // an empty preamble at the top of every untracked-only review.
  if (tracked.stdout === '') return untrackedDiff
  if (untrackedDiff === '') return tracked.stdout
  return tracked.stdout.endsWith('\n')
    ? tracked.stdout + untrackedDiff
    : tracked.stdout + '\n' + untrackedDiff
}

/**
 * Capped variant of `gitDiffSnapshot` for the HTTP response in
 * `GET /api/tasks/:id/diff`. v1 caps at 1 MiB to keep the network round-trip
 * predictable; multi-process sharding uses the uncapped form.
 */
export async function worktreeDiff(
  worktreePath: string,
  fromCommit: string,
): Promise<{ diff: string; truncated: boolean }> {
  const MAX_BYTES = 1024 * 1024 // 1 MiB
  const diff = await gitDiffSnapshot(worktreePath, fromCommit)
  if (diff.length > MAX_BYTES) {
    return { diff: diff.slice(0, MAX_BYTES), truncated: true }
  }
  return { diff, truncated: false }
}

/**
 * Capture the worktree state as a git stash entry without committing it
 * (P-3-07). Returns the stash sha — caller persists it in
 * `node_runs.pre_snapshot` for later rollback on retry/resume.
 *
 * `git stash create` produces a commit object referenced only by the
 * returned sha; it does NOT push to the stash list, so concurrent stashes
 * across tasks don't fight over reflog ordering. Empty trees return ''.
 */
export async function gitStashSnapshot(worktreePath: string): Promise<string> {
  const r = await runGit(worktreePath, ['stash', 'create'])
  if (r.exitCode !== 0) {
    throw new DomainError('worktree-snapshot-failed', `git stash create: ${r.stderr.trim()}`, 500)
  }
  return r.stdout.trim()
}

/**
 * Roll the worktree back to a previously-captured snapshot sha
 * (P-3-07). Used before a single-node retry or `POST /tasks/:id/resume`
 * so writes from the prior attempt don't compound.
 *
 * Implementation:
 *   - `git reset --hard HEAD` (drop staged + tracked working-tree changes)
 *   - `git clean -fd` (drop untracked files + dirs)
 *   - `git stash apply <sha> --index` (restore the snapshot tree)
 *
 * When `snapshotSha` is empty (no captured snapshot — e.g. read-only
 * node, or the worktree was clean at snapshot time), the function still
 * does reset+clean so any partial bad write outside the snapshot window
 * is cleared.
 */
export async function rollbackToSnapshot(worktreePath: string, snapshotSha: string): Promise<void> {
  const reset = await runGit(worktreePath, ['reset', '--hard', 'HEAD'])
  if (reset.exitCode !== 0) {
    throw new DomainError('worktree-reset-failed', `git reset: ${reset.stderr.trim()}`, 500)
  }
  const clean = await runGit(worktreePath, ['clean', '-fd'])
  if (clean.exitCode !== 0) {
    throw new DomainError('worktree-clean-failed', `git clean: ${clean.stderr.trim()}`, 500)
  }
  if (snapshotSha !== '') {
    const apply = await runGit(worktreePath, ['stash', 'apply', '--index', snapshotSha])
    if (apply.exitCode !== 0) {
      throw new DomainError('worktree-apply-failed', `git stash apply: ${apply.stderr.trim()}`, 500)
    }
  }
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
