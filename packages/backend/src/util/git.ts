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
// RFC-068 — base ref classification
// -----------------------------------------------------------------------------

/**
 * Kind of a base ref the launcher passed in. Used by RFC-068 to decide whether
 * to fast-forward a mirror's local branch to its remote-tracking counterpart
 * before materializing a worktree.
 *
 * - 'branch' — local branch (`refs/heads/<name>`). FF candidate.
 * - 'remote-tracking' — `refs/remotes/<remote>/<name>`. Already points at the
 *   remote-side commit; no FF needed.
 * - 'tag' — `refs/tags/<name>`. Fixed object; FF inapplicable.
 * - 'sha' — looks like a hex commit sha and resolves to a commit. FF
 *   inapplicable.
 * - 'unknown' — none of the above. Callers should treat as "try as branch"
 *   (the FF attempt will silently skip if there's no matching origin ref).
 */
export type BaseRefKind = 'branch' | 'remote-tracking' | 'tag' | 'sha' | 'unknown'

const HEX_SHA_RE = /^[0-9a-f]{4,40}$/i

/**
 * Classify a base ref against the local repo's ref store. Read-only, side-
 * effect free; runs `git for-each-ref` once + an optional `rev-parse` probe.
 *
 * Priority: branch > tag > remote-tracking > sha > unknown. We rank `branch`
 * above `tag` so that a `git tag` with the same name as an existing branch
 * does not accidentally short-circuit FF (this matches launcher UX — users
 * pick branch names from the branches dropdown).
 */
export async function classifyBaseRef(repoPath: string, ref: string): Promise<BaseRefKind> {
  if (ref === '' || ref === 'HEAD') return 'unknown'

  const probe = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    `refs/heads/${ref}`,
    `refs/tags/${ref}`,
    `refs/remotes/${ref}`,
  ])
  if (probe.exitCode === 0) {
    const lines = probe.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    if (lines.some((l) => l.startsWith('refs/heads/'))) return 'branch'
    if (lines.some((l) => l.startsWith('refs/tags/'))) return 'tag'
    if (lines.some((l) => l.startsWith('refs/remotes/'))) return 'remote-tracking'
  }

  if (HEX_SHA_RE.test(ref)) {
    const r = await runGit(repoPath, ['rev-parse', '--verify', `${ref}^{commit}`])
    if (r.exitCode === 0) return 'sha'
  }

  return 'unknown'
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
  /**
   * RFC-066: when provided, use this absolute path as the worktree directory
   * instead of the default `{appHome}/worktrees/{repoSlug}/{taskId}` layout.
   * Used by the multi-repo materialize branch to place per-repo worktrees as
   * siblings under a parent `multi/{taskId}/` directory (with auto-suffix
   * collision-resolved basenames). Single-repo path-mode + URL-mode callers
   * MUST NOT pass this so the legacy `{repoSlug}/{taskId}` layout stays
   * byte-for-byte identical.
   */
  overrideWorktreePath?: string
  /**
   * RFC-075: optional user-specified working branch. When provided it
   * REPLACES the default `agent-workflow/{taskId}` as the worktree's
   * checked-out branch:
   *   - absent on both local + remote → created off `baseCommit`;
   *   - existing (local or remote) → reused (checked out) and `baseCommit`
   *     (the RFC-068 remote-synced base) is merged in.
   * Throws a typed ValidationError with a stable code on invalid name /
   * `working-branch-in-use` / `working-branch-base-fetch-failed` /
   * `working-branch-base-merge-conflict`. Omitted → legacy behavior,
   * byte-for-byte unchanged.
   */
  workingBranch?: string
  /**
   * RFC-075 + RFC-067: task Git identity used for the framework's own merge
   * commit when reusing a working branch needs a non-fast-forward merge (a
   * true merge commit needs an author/committer). Both omitted → the merge
   * inherits the daemon's git config like any other launch-time git call.
   */
  gitUserName?: string | null
  gitUserEmail?: string | null
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
  // RFC-066: caller can override the auto-composed path (multi-repo branches
  // place worktrees under `multi/{taskId}/<basename>/`). Single-repo callers
  // omit this and inherit the legacy `{repoSlug}/{taskId}` layout — locked
  // by the G3 grep guard in tests/source/start-task-single-path-baseline.test.ts.
  const slug = repoSlug(opts.repoPath)
  const worktreePath =
    opts.overrideWorktreePath ?? join(opts.appHome, 'worktrees', slug, opts.taskId)
  // Pick base ref. Falls back to HEAD when caller didn't specify.
  const base = opts.baseBranch ?? (await currentBranch(opts.repoPath)) ?? 'HEAD'

  // Resolve to a concrete commit so the worktree is reproducible even if base
  // is a symbolic ref that moves underneath us. RFC-068 has already synced the
  // base to remote-latest by the time we get here.
  const baseRev = await runGit(opts.repoPath, ['rev-parse', base])
  if (baseRev.exitCode !== 0) {
    // RFC-075: with a working branch, an unresolvable base is a hard launch
    // failure (we cannot honor "branch off remote latest"); without one we
    // keep the legacy error code byte-for-byte.
    if (opts.workingBranch) {
      throw new ValidationError(
        'working-branch-base-fetch-failed',
        `cannot resolve base ref '${base}' for working branch '${opts.workingBranch}'`,
        { stderr: baseRev.stderr.trim() },
      )
    }
    throw new ValidationError('worktree-base-invalid', `cannot resolve base ref '${base}'`, {
      stderr: baseRev.stderr.trim(),
    })
  }
  const baseCommit = baseRev.stdout.trim()

  // RFC-075: a user-specified working branch replaces the default isolation
  // branch as the worktree's checked-out branch. Omitted → byte-for-byte
  // legacy behavior (grep guard locks the `agent-workflow/{taskId}` literal).
  const branch = opts.workingBranch ?? `agent-workflow/${opts.taskId}`
  if (opts.workingBranch) {
    await checkoutWorkingBranch({
      repoPath: opts.repoPath,
      worktreePath,
      branch: opts.workingBranch,
      baseCommit,
      gitUserName: opts.gitUserName ?? null,
      gitUserEmail: opts.gitUserEmail ?? null,
    })
  } else {
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

/** `-c user.name=… -c user.email=…` args when both are present, else []. */
function gitIdentityArgs(name: string | null, email: string | null): string[] {
  const n = name?.trim()
  const e = email?.trim()
  if (n && e) return ['-c', `user.name=${n}`, '-c', `user.email=${e}`]
  return []
}

function mapWorktreeAddError(stderr: string, branch: string): Error {
  // `git worktree add` refuses a branch already checked out elsewhere with
  // "fatal: '<branch>' is already used by worktree at '<path>'".
  if (/already (used|checked out|being used) by worktree/i.test(stderr)) {
    return new ValidationError(
      'working-branch-in-use',
      `working branch '${branch}' is already checked out by another worktree`,
      { stderr: stderr.trim() },
    )
  }
  return new DomainError('worktree-add-failed', `git worktree add failed: ${stderr.trim()}`, 500)
}

/**
 * RFC-075: materialize a user-specified working branch into a fresh worktree.
 *
 *  - Validates the branch name via `git check-ref-format --branch`.
 *  - New branch (absent local + remote) → `worktree add -b` off `baseCommit`.
 *  - Existing branch (local or remote) → reuse: check it out into the worktree
 *    and `git merge` `baseCommit` (the RFC-068 remote-synced base) into it.
 *
 * On any failure the partially-created worktree is torn down so a failed
 * launch leaves nothing behind, and a typed ValidationError with a stable
 * code is thrown. Remote existence is probed via `ls-remote origin`; a
 * network failure there degrades to "remote absent" (we create a fresh branch
 * and let the eventual push reconcile), which is the pragmatic v1 stance.
 */
async function checkoutWorkingBranch(opts: {
  repoPath: string
  worktreePath: string
  branch: string
  baseCommit: string
  gitUserName: string | null
  gitUserEmail: string | null
}): Promise<void> {
  const { repoPath, worktreePath, branch, baseCommit } = opts

  // 1. Authoritative name validation (mirrors shared isLooseValidBranchName).
  const fmt = await runGit(repoPath, ['check-ref-format', '--branch', branch])
  if (fmt.exitCode !== 0) {
    throw new ValidationError('working-branch-invalid', `invalid working branch name '${branch}'`, {
      stderr: fmt.stderr.trim(),
    })
  }

  // 2. Existence probes: local head + remote head.
  const localExists =
    (await runGit(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))
      .exitCode === 0
  const remoteLs = await runGit(repoPath, ['ls-remote', '--heads', 'origin', branch])
  const remoteExists = remoteLs.exitCode === 0 && remoteLs.stdout.trim().length > 0

  // 3a. New branch off the remote-synced base — no merge needed.
  if (!localExists && !remoteExists) {
    const add = await runGit(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseCommit])
    if (add.exitCode !== 0) throw mapWorktreeAddError(add.stderr, branch)
    return
  }

  // 3b. Reuse. When the branch lives only on the remote, fetch it and create a
  // local branch off the remote tip; otherwise check out the existing local.
  if (!localExists && remoteExists) {
    const fetch = await runGit(repoPath, [
      'fetch',
      'origin',
      `${branch}:refs/remotes/origin/${branch}`,
    ])
    if (fetch.exitCode !== 0) {
      throw new ValidationError(
        'working-branch-base-fetch-failed',
        `failed to fetch existing remote working branch '${branch}'`,
        { stderr: fetch.stderr.trim() },
      )
    }
    const add = await runGit(repoPath, [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      `refs/remotes/origin/${branch}`,
    ])
    if (add.exitCode !== 0) throw mapWorktreeAddError(add.stderr, branch)
  } else {
    const add = await runGit(repoPath, ['worktree', 'add', worktreePath, branch])
    if (add.exitCode !== 0) throw mapWorktreeAddError(add.stderr, branch)
  }

  // 4. Merge the remote-synced base into the checked-out working branch. A
  // fast-forward needs no identity; a true merge commit uses the task identity
  // (RFC-067) when present, else the daemon's git config.
  const merge = await runGit(worktreePath, [
    ...gitIdentityArgs(opts.gitUserName, opts.gitUserEmail),
    'merge',
    '--no-edit',
    baseCommit,
  ])
  if (merge.exitCode !== 0) {
    // Abort the conflicted merge and tear the worktree back down.
    await runGit(worktreePath, ['merge', '--abort'])
    await runGit(repoPath, ['worktree', 'remove', '--force', worktreePath])
    throw new ValidationError(
      'working-branch-base-merge-conflict',
      `merging base into working branch '${branch}' produced a conflict`,
      { stderr: merge.stderr.trim() },
    )
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
 * RFC-060 PR-E — wrapper-git output kind upgrade. Returns the
 * newline-separated list of paths that differ between `fromCommit` and the
 * current worktree (committed-but-uncommitted + untracked files). The
 * wrapper-git node's `git_diff` outlet now carries this `list<path>` value
 * instead of a full unified diff, so it can feed a downstream wrapper-fanout
 * as a shardSource directly.
 *
 * Implementation:
 *   - `git diff --name-only <fromCommit>` for tracked changes
 *   - `git ls-files --others --exclude-standard` for untracked paths
 *   - `core.quotepath=false` so non-ASCII paths survive unescaped (mirrors
 *     gitDiffSnapshot).
 *
 * Empty when nothing changed (`fromCommit === HEAD` of a clean worktree).
 */
export async function gitChangedFiles(worktreePath: string, fromCommit: string): Promise<string[]> {
  const tracked = await runGit(worktreePath, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    fromCommit,
    '--',
  ])
  if (tracked.exitCode !== 0) {
    throw new DomainError(
      'worktree-diff-failed',
      `git diff --name-only failed: ${tracked.stderr.trim()}`,
      500,
    )
  }
  const untracked = await runGit(worktreePath, [
    '-c',
    'core.quotepath=false',
    'ls-files',
    '--others',
    '--exclude-standard',
  ])
  const out: string[] = []
  const seen = new Set<string>()
  for (const line of tracked.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  for (const line of untracked.stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    if (seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
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
