// git CLI helpers used by repo endpoints, the runner, and worktree management.
//
// Shells out to `git` (we depend on >= 2.5 — checked in `doctor`). All output
// is line-parsed; no porcelain v2 / NUL-separated yet — paths with newlines
// will not survive lsFiles, which we accept as a v1 limitation.

import type { GitRef } from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rm, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { Logger } from '@/util/log'

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

/**
 * RFC-130: a FIXED author/committer identity for the platform's INTERNAL git commits
 * — the iso full-state snapshots (`snapshotFullState`) and the merge-resolution /
 * shard-replacement trees (`commitTree`). These are implementation-detail objects, so
 * they must NEVER depend on the ambient git config: a task worktree cloned from a URL
 * inherits no `user.name`/`user.email`, and some CI runners (notably GitHub's ubuntu
 * image) also have no global identity AND cannot auto-detect one (no resolvable
 * user@host email) — so a bare `git commit-tree` there fails with "committer identity
 * unknown", which surfaced as `iso-setup-failed` on ubuntu-only. Injecting this env
 * makes those internal commits succeed regardless of the host/worktree git config.
 * (RFC auto commit&push prefers the task's own identity when the launch
 * supplied one; commitPushRunner falls back to THIS identity otherwise —
 * a URL/scratch worktree's cache-clone parent carries no local user.*, so
 * "inherit the ambient config" meant guaranteed failure on such hosts.)
 */
export const AW_INTERNAL_GIT_IDENTITY: Record<string, string> = {
  GIT_AUTHOR_NAME: 'agent-workflow',
  GIT_AUTHOR_EMAIL: 'agent-workflow@localhost',
  GIT_COMMITTER_NAME: 'agent-workflow',
  GIT_COMMITTER_EMAIL: 'agent-workflow@localhost',
}

/**
 * RFC-165: materialize a temporary-space ("scratch") workspace — a brand-new
 * git repo whose empty root commit is the diff base. The workspace IS the
 * repo (`tasks.repo_path === tasks.worktree_path`); iso worktrees branch off
 * its shared ODB exactly like any canonical worktree. The empty root commit
 * is REQUIRED: the snapshot machinery resolves `HEAD` (snapshotFullState),
 * and the task's produced-files diff is computed against it.
 *
 * Identity (design N2): the per-task git identity when the launch supplied
 * one, else the fixed platform identity — NEVER the ambient git config
 * (URL-cloned hosts and CI runners may have none; see
 * AW_INTERNAL_GIT_IDENTITY above for the incident write-up).
 *
 * Never throws — mirrors createWorktree's `{ earlyError }` discipline via a
 * tagged result so the caller can mint a failed task row exactly once.
 */
export async function initScratchRepo(opts: {
  dir: string
  gitUserName?: string | null
  gitUserEmail?: string | null
}): Promise<{ ok: true; rootCommit: string } | { ok: false; error: string }> {
  try {
    await mkdir(opts.dir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `scratch-mkdir-failed: ${(err as Error).message}` }
  }
  const identity =
    opts.gitUserName != null &&
    opts.gitUserName !== '' &&
    opts.gitUserEmail != null &&
    opts.gitUserEmail !== ''
      ? {
          GIT_AUTHOR_NAME: opts.gitUserName,
          GIT_AUTHOR_EMAIL: opts.gitUserEmail,
          GIT_COMMITTER_NAME: opts.gitUserName,
          GIT_COMMITTER_EMAIL: opts.gitUserEmail,
        }
      : AW_INTERNAL_GIT_IDENTITY
  const init = await runGit(opts.dir, ['init', '-b', 'main'])
  if (init.exitCode !== 0) {
    return { ok: false, error: `scratch-init-failed: ${init.stderr.trim()}` }
  }
  const commit = await runGit(
    opts.dir,
    ['commit', '--allow-empty', '-m', 'agent-workflow scratch root'],
    { env: identity },
  )
  if (commit.exitCode !== 0) {
    return { ok: false, error: `scratch-root-commit-failed: ${commit.stderr.trim()}` }
  }
  const head = await runGit(opts.dir, ['rev-parse', 'HEAD'])
  if (head.exitCode !== 0) {
    return { ok: false, error: `scratch-head-failed: ${head.stderr.trim()}` }
  }
  return { ok: true, rootCommit: head.stdout.trim() }
}

/**
 * Run `git -C <cwd> <...args>` and capture stdout/stderr. Never throws.
 *
 * RFC-130 (D25): optional `opts.env` is MERGED OVER `nonInteractiveGitEnv()` so
 * callers can inject per-spawn vars (e.g. `GIT_INDEX_FILE` for a temp index in
 * `snapshotFullState`) without clobbering the non-interactive ssh/https guards.
 * A key whose value is `undefined` unsets that var for this spawn.
 */
export async function runGit(
  cwd: string,
  args: string[],
  opts?: { env?: Record<string, string | undefined>; stdin?: string; timeoutMs?: number },
): Promise<GitRunResult> {
  const proc = Bun.spawn({
    cmd: ['git', '-C', cwd, ...args],
    // Explicit env passthrough — Bun.spawn under `bun test` does not pick up
    // post-startup process.env mutations otherwise, which makes per-test env
    // injection (e.g. GIT_CONFIG_GLOBAL) unreliable. In production this is a
    // no-op since process.env is fixed at daemon start.
    env:
      opts?.env === undefined ? nonInteractiveGitEnv() : { ...nonInteractiveGitEnv(), ...opts.env },
    stdout: 'pipe',
    stderr: 'pipe',
    // RFC-187 §4-2: `update-index --index-info` reads entries from stdin — the
    // ONLY plumbing shape git offers for surgical index edits. Callers that
    // don't pass `stdin` keep the historical ignore (no behavior change).
    stdin: opts?.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    // RFC-208: with a timeout the child runs in its OWN process group so the
    // timer can SIGKILL the whole tree. git delegates freely (credential
    // helpers, ssh, `!`-aliases through a shell), and killing only the direct
    // child leaves those grandchildren alive holding the pipes — the exact
    // failure util/opencode.ts already learned. Without a timeout the historical
    // flat spawn is kept byte-for-byte.
    ...(opts?.timeoutMs !== undefined ? { detached: true } : {}),
  })

  if (opts?.timeoutMs === undefined) {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }, opts.timeoutMs)
  try {
    // Await the exit FIRST, then bound the pipe reads: a surviving grandchild
    // can inherit the write end and keep `.text()` from ever seeing EOF even
    // after the direct child is reaped (util/opencode.ts §probe).
    const outPromise = new Response(proc.stdout).text().catch(() => '')
    const errPromise = new Response(proc.stderr).text().catch(() => '')
    const exitCode = await proc.exited
    const drained = <T>(p: Promise<T>, fallback: T): Promise<T> =>
      Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), 250))])
    const stdout = await drained(outPromise, '')
    const stderr = await drained(errPromise, '')
    if (!timedOut) return { stdout, stderr, exitCode }
    return {
      stdout,
      // Timeouts must be diagnosable, and must never be mistaken for success:
      // a SIGKILLed process can surface exitCode 0/null depending on platform.
      stderr: `${stderr}\ngit timed out after ${opts.timeoutMs}ms (killed)`.trim(),
      exitCode: exitCode === 0 ? GIT_TIMEOUT_EXIT_CODE : exitCode,
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Conventional "timed out" exit status (matches coreutils `timeout`). */
export const GIT_TIMEOUT_EXIT_CODE = 124

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

/**
 * True only when `path` is the working tree of a git repository — i.e. a
 * directory `git diff` / `git ls-files` can actually run in.
 *
 * Why this exists separate from `existsSync`: a task worktree lives under
 * `~/.agent-workflow/worktrees/...` and its `.git` is a *file* pointing at the
 * source repo's `.git/worktrees/<id>`. If the source repo is later moved or
 * deleted (or the `.git` file is removed), the worktree directory survives on
 * disk — `existsSync` still returns true — but git can no longer resolve it.
 * `git diff <commit>` then either prints `fatal: not a git repository: <gitdir>`
 * or falls back to its `--no-index` mode and dumps a hundreds-of-lines usage
 * block. Callers that gate on a usable worktree must probe this, not just the
 * directory's existence.
 *
 * `git rev-parse --is-inside-work-tree` prints `true` (exit 0) inside a work
 * tree and fails (exit 128) otherwise. We also reject the `false`/exit-0 case
 * (cwd is a bare repo / inside `.git`) since every caller wants a real work
 * tree.
 */
export async function isGitWorkTree(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  const r = await runGit(path, ['rev-parse', '--is-inside-work-tree'])
  return r.exitCode === 0 && r.stdout.trim() === 'true'
}

/**
 * Collapse a `git diff` failure into one actionable line. When the worktree
 * dir exists but isn't a git repo (source repo moved/deleted, `.git` removed),
 * git falls back to its `--no-index` path and writes a hundreds-of-lines usage
 * block to stderr (led by `warning: Not a git repository...`), or prints
 * `fatal: not a git repository: <gitdir>`. Surfacing that whole blob as the
 * error message is useless noise — and it's exactly what reached the task
 * detail "工作目录 diff" tab. Replace it with a concise sentence; any other
 * failure (bad revision, etc.) keeps its real stderr for debugging.
 */
function diffFailureMessage(worktreePath: string, stderr: string): string {
  const trimmed = stderr.trim()
  if (/not a git repository/i.test(trimmed)) {
    return `git diff failed: '${worktreePath}' is not a git repository (worktree removed or its source repo is gone)`
  }
  return `git diff failed: ${trimmed}`
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
  /**
   * RFC-199 deterministic lifecycle seam. Production callers omit this;
   * regression tests use it to place an external ref writer in the two
   * working-branch CAS windows and to inject post-add cleanup failures.
   */
  lifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
}

export interface WorktreeLifecycleHookEvent {
  stage:
    | 'working-branch-after-capture'
    | 'working-branch-prepared-before-cas'
    | 'post-add-before-submodules'
    | 'post-add-cleanup-worktree-remove'
    | 'post-add-cleanup-branch-restore'
  repoPath: string
  worktreePath: string
  branch: string
  branchRef: string
  branchBefore: string | null
  preparedCommit?: string
}

export interface CreatedWorktree {
  worktreePath: string
  branch: string
  /** Source-repo commit the worktree starts from (for snapshotting later). */
  baseCommit: string
  /**
   * Exact launch-time ownership record. Cleanup must use this record instead
   * of guessing from a branch name or path shape: a user working branch may
   * have existed before launch and may have been advanced by the base merge.
   */
  cleanup: WorktreeCleanupProvenance
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

/**
 * Git ownership captured around one successful `git worktree add`.
 *
 * `branchBefore` is the local branch ref before this launch (`null` when the
 * launch created it). `branchAfter` is the exact ref value after materialize.
 * Rollback uses those values as compare-and-swap operands, so a concurrent ref
 * writer is never overwritten or force-deleted.
 */
export interface WorktreeCleanupProvenance {
  repoPath: string
  worktreePath: string
  branch: string
  branchRef: string
  branchBefore: string | null
  branchAfter: string
}

export interface WorktreeCleanupResult {
  worktreeRemoved: boolean
  branchRestored: boolean
  failures: Array<{
    stage: 'worktree-remove' | 'branch-restore'
    message: string
  }>
}

type LocalBranchRefRead =
  | { kind: 'present'; value: string }
  | { kind: 'missing' }
  | { kind: 'error'; message: string }

async function inspectLocalBranchRef(
  repoPath: string,
  branchRef: string,
): Promise<LocalBranchRefRead> {
  const result = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', branchRef])
  if (result.exitCode === 0) return { kind: 'present', value: result.stdout.trim() }
  // `rev-parse --verify --quiet` uses 1 for an absent ref. Any other status
  // is a repository/read failure and must never be collapsed into "missing".
  if (result.exitCode === 1) return { kind: 'missing' }
  return {
    kind: 'error',
    message:
      result.stderr.trim() ||
      `git rev-parse exited ${result.exitCode} while reading '${branchRef}'`,
  }
}

async function readLocalBranchRef(repoPath: string, branchRef: string): Promise<string | null> {
  const result = await inspectLocalBranchRef(repoPath, branchRef)
  if (result.kind === 'present') return result.value
  if (result.kind === 'missing') return null
  throw new DomainError(
    'worktree-branch-ref-read-failed',
    `cannot read local branch ref '${branchRef}'`,
    500,
    { repoPath, message: result.message },
  )
}

async function restoreBranchRefCas(
  provenance: WorktreeCleanupProvenance,
  beforeStage?: () => void | Promise<void>,
): Promise<Pick<WorktreeCleanupResult, 'branchRestored' | 'failures'>> {
  const failures: WorktreeCleanupResult['failures'] = []
  try {
    await beforeStage?.()
  } catch (error) {
    failures.push({
      stage: 'branch-restore',
      message: error instanceof Error ? error.message : String(error),
    })
    return { branchRestored: false, failures }
  }

  const read = await inspectLocalBranchRef(provenance.repoPath, provenance.branchRef)
  if (read.kind === 'error') {
    failures.push({ stage: 'branch-restore', message: read.message })
    return { branchRestored: false, failures }
  }
  const current = read.kind === 'present' ? read.value : null
  if (current === provenance.branchBefore) return { branchRestored: true, failures }

  const restore =
    provenance.branchBefore === null
      ? await runGit(provenance.repoPath, [
          'update-ref',
          '-d',
          provenance.branchRef,
          provenance.branchAfter,
        ])
      : await runGit(provenance.repoPath, [
          'update-ref',
          provenance.branchRef,
          provenance.branchBefore,
          provenance.branchAfter,
        ])
  if (restore.exitCode !== 0) {
    failures.push({
      stage: 'branch-restore',
      message:
        restore.stderr.trim() ||
        `branch ref changed concurrently (expected ${provenance.branchAfter}, found ${current ?? 'missing'})`,
    })
  }
  return { branchRestored: restore.exitCode === 0, failures }
}

/**
 * Remove a launch-owned linked worktree and CAS-restore its branch ref.
 *
 * The ref operation deliberately uses `git update-ref <ref> <new> <old>` (or
 * `-d <ref> <old>` for a branch minted by this launch). A ref that moved after
 * materialization is retained and reported as incomplete cleanup; it is never
 * force-reset to the stale launch-time value.
 */
export async function cleanupCreatedWorktree(
  provenance: WorktreeCleanupProvenance,
  opts?: {
    beforeStage?: (stage: 'worktree-remove' | 'branch-restore') => void | Promise<void>
  },
): Promise<WorktreeCleanupResult> {
  const failures: WorktreeCleanupResult['failures'] = []
  try {
    await opts?.beforeStage?.('worktree-remove')
  } catch (error) {
    failures.push({
      stage: 'worktree-remove',
      message: error instanceof Error ? error.message : String(error),
    })
    return { worktreeRemoved: false, branchRestored: false, failures }
  }
  const remove = await runGit(provenance.repoPath, [
    'worktree',
    'remove',
    '--force',
    provenance.worktreePath,
  ])
  if (remove.exitCode !== 0) {
    failures.push({
      stage: 'worktree-remove',
      message: remove.stderr.trim() || `git worktree remove exited ${remove.exitCode}`,
    })
    return { worktreeRemoved: false, branchRestored: false, failures }
  }

  const branch = await restoreBranchRefCas(provenance, () => opts?.beforeStage?.('branch-restore'))
  failures.push(...branch.failures)
  return {
    worktreeRemoved: true,
    branchRestored: branch.branchRestored,
    failures,
  }
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
  let cleanup: WorktreeCleanupProvenance
  if (opts.workingBranch) {
    cleanup = await checkoutWorkingBranch({
      repoPath: opts.repoPath,
      worktreePath,
      branch: opts.workingBranch,
      baseCommit,
      gitUserName: opts.gitUserName ?? null,
      gitUserEmail: opts.gitUserEmail ?? null,
      ...(opts.lifecycleHook !== undefined ? { lifecycleHook: opts.lifecycleHook } : {}),
    })
  } else {
    const branchRef = `refs/heads/${branch}`
    const branchBefore = await readLocalBranchRef(opts.repoPath, branchRef)
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
    cleanup = {
      repoPath: opts.repoPath,
      worktreePath,
      branch,
      branchRef,
      branchBefore,
      // `worktree add -b <branch> <path> <baseCommit>` creates the ref at this
      // exact commit; retaining the operand here also avoids an unowned gap if
      // a post-add ref read itself fails.
      branchAfter: baseCommit,
    }
  }

  const sub = await (async () => {
    try {
      await opts.lifecycleHook?.({
        stage: 'post-add-before-submodules',
        repoPath: cleanup.repoPath,
        worktreePath: cleanup.worktreePath,
        branch: cleanup.branch,
        branchRef: cleanup.branchRef,
        branchBefore: cleanup.branchBefore,
        preparedCommit: cleanup.branchAfter,
      })
      // RFC-034: dynamic import to avoid a circular dep between util/git.ts and
      // services/gitSubmodule.ts (which itself imports runGit from this file).
      const { syncSubmodules } = await import('@/services/gitSubmodule')
      const { resolveSubmoduleParams } = await import('@/services/gitRepoCache')
      const effective = resolveSubmoduleParams(opts.submoduleMode, opts.submoduleJobs)
      return await syncSubmodules(worktreePath, {
        mode: effective.mode,
        jobs: effective.jobs,
      })
    } catch (error) {
      // Once `worktree add` succeeds this helper owns both the registration and
      // the exact branch mutation. An unexpected post-add failure is cleaned
      // here because no caller has received the provenance handoff yet.
      const cleanupResult = await cleanupCreatedWorktree(cleanup, {
        beforeStage: async (stage) => {
          await opts.lifecycleHook?.({
            stage:
              stage === 'worktree-remove'
                ? 'post-add-cleanup-worktree-remove'
                : 'post-add-cleanup-branch-restore',
            repoPath: cleanup.repoPath,
            worktreePath: cleanup.worktreePath,
            branch: cleanup.branch,
            branchRef: cleanup.branchRef,
            branchBefore: cleanup.branchBefore,
            preparedCommit: cleanup.branchAfter,
          })
        },
      })
      if (cleanupResult.failures.length > 0) {
        throw new DomainError(
          'worktree-post-add-cleanup-incomplete',
          error instanceof Error ? error.message : String(error),
          500,
          { cleanup: cleanupResult },
        )
      }
      throw error
    }
  })()

  return {
    worktreePath,
    branch,
    baseCommit,
    cleanup,
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

interface RegisteredWorktree {
  path: string
  branchRef: string | null
}

async function listRegisteredWorktrees(repoPath: string): Promise<RegisteredWorktree[]> {
  const list = await runGit(repoPath, ['worktree', 'list', '--porcelain'])
  if (list.exitCode !== 0) {
    throw new DomainError(
      'working-branch-state-read-failed',
      `cannot inspect worktrees for '${repoPath}'`,
      500,
      { stderr: list.stderr.trim() },
    )
  }
  const registrations: RegisteredWorktree[] = []
  let current: RegisteredWorktree | null = null
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current !== null) registrations.push(current)
      current = { path: line.slice('worktree '.length), branchRef: null }
    } else if (line.startsWith('branch ') && current !== null) {
      current.branchRef = line.slice('branch '.length)
    }
  }
  if (current !== null) registrations.push(current)
  return registrations
}

async function assertWorkingBranchNotInUse(
  repoPath: string,
  branch: string,
  branchRef: string,
): Promise<void> {
  const owner = (await listRegisteredWorktrees(repoPath)).find(
    (registration) => registration.branchRef === branchRef,
  )
  if (owner !== undefined) {
    throw new ValidationError(
      'working-branch-in-use',
      `working branch '${branch}' is already checked out by another worktree`,
      { worktreePath: owner.path },
    )
  }
}

async function cleanupFailedWorkingBranchAttach(
  provenance: WorktreeCleanupProvenance,
): Promise<WorktreeCleanupResult> {
  let registrations: RegisteredWorktree[]
  try {
    registrations = await listRegisteredWorktrees(provenance.repoPath)
  } catch (error) {
    return {
      worktreeRemoved: false,
      branchRestored: false,
      failures: [
        {
          stage: 'worktree-remove',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  }

  if (registrations.some((registration) => registration.path === provenance.worktreePath)) {
    return cleanupCreatedWorktree(provenance)
  }

  const externalOwner = registrations.find(
    (registration) => registration.branchRef === provenance.branchRef,
  )
  if (externalOwner !== undefined) {
    return {
      worktreeRemoved: true,
      branchRestored: false,
      failures: [
        {
          stage: 'branch-restore',
          message: `working branch is now checked out at '${externalOwner.path}'`,
        },
      ],
    }
  }

  const branch = await restoreBranchRefCas(provenance)
  return { worktreeRemoved: true, branchRestored: branch.branchRestored, failures: branch.failures }
}

function cleanupFailureDetails(error: Error, cleanup: WorktreeCleanupResult): unknown {
  return {
    cause:
      error instanceof DomainError
        ? { code: error.code, status: error.status, details: error.details }
        : { message: error.message },
    cleanup,
  }
}

/**
 * RFC-075: materialize a user-specified working branch into a fresh worktree.
 *
 *  - Validates the branch name via `git check-ref-format --branch`.
 *  - New branch (absent local + remote) → prepare `baseCommit`.
 *  - Existing branch (local or remote) → merge `baseCommit` in a detached
 *    preparation worktree, never in the user branch's attached worktree.
 *  - Publish with one expected-old `update-ref` CAS, then attach the branch.
 *    Ownership is never inferred from a ref read after merge.
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
  lifecycleHook?: (event: WorktreeLifecycleHookEvent) => void | Promise<void>
}): Promise<WorktreeCleanupProvenance> {
  const { repoPath, worktreePath, branch, baseCommit } = opts
  const branchRef = `refs/heads/${branch}`

  // 1. Authoritative name validation (mirrors shared isLooseValidBranchName).
  const fmt = await runGit(repoPath, ['check-ref-format', '--branch', branch])
  if (fmt.exitCode !== 0) {
    throw new ValidationError('working-branch-invalid', `invalid working branch name '${branch}'`, {
      stderr: fmt.stderr.trim(),
    })
  }

  // 2. Capture the expected-old operand before any preparation. A writer in
  // either hook window makes the final CAS fail instead of becoming part of
  // this launch's cleanup provenance.
  const branchBefore = await readLocalBranchRef(repoPath, branchRef)
  await opts.lifecycleHook?.({
    stage: 'working-branch-after-capture',
    repoPath,
    worktreePath,
    branch,
    branchRef,
    branchBefore,
  })
  await assertWorkingBranchNotInUse(repoPath, branch, branchRef)

  // 3. Resolve the preparation start without creating or moving the local
  // head. Remote-only reuse fetches a tracking ref; the local branch remains
  // absent until the CAS below.
  let preparationStart = branchBefore
  if (preparationStart === null) {
    const remoteLs = await runGit(repoPath, ['ls-remote', '--heads', 'origin', branch])
    const remoteExists = remoteLs.exitCode === 0 && remoteLs.stdout.trim().length > 0
    if (remoteExists) {
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
      const remoteHead = await runGit(repoPath, [
        'rev-parse',
        '--verify',
        `refs/remotes/origin/${branch}^{commit}`,
      ])
      if (remoteHead.exitCode !== 0) {
        throw new ValidationError(
          'working-branch-base-fetch-failed',
          `cannot resolve fetched remote working branch '${branch}'`,
          { stderr: remoteHead.stderr.trim() },
        )
      }
      preparationStart = remoteHead.stdout.trim()
    }
  }
  preparationStart ??= baseCommit

  // 4. Compute the merge result in detached state. The merge may write an
  // object, but cannot move the user's branch ref.
  let preparedCommit = baseCommit
  if (branchBefore !== null || preparationStart !== baseCommit) {
    const prepare = await runGit(repoPath, [
      'worktree',
      'add',
      '--detach',
      worktreePath,
      preparationStart,
    ])
    if (prepare.exitCode !== 0) throw mapWorktreeAddError(prepare.stderr, branch)

    const merge = await runGit(worktreePath, [
      ...gitIdentityArgs(opts.gitUserName, opts.gitUserEmail),
      'merge',
      '--no-edit',
      baseCommit,
    ])
    if (merge.exitCode !== 0) {
      await runGit(worktreePath, ['merge', '--abort'])
      const remove = await runGit(repoPath, ['worktree', 'remove', '--force', worktreePath])
      if (remove.exitCode !== 0) {
        throw new DomainError(
          'working-branch-prepare-cleanup-incomplete',
          `merging base into working branch '${branch}' failed and the detached preparation worktree could not be removed`,
          500,
          {
            stderr: merge.stderr.trim(),
            cleanup: {
              worktreePath,
              worktreeRemoved: false,
              message: remove.stderr.trim(),
            },
          },
        )
      }
      throw new ValidationError(
        'working-branch-base-merge-conflict',
        `merging base into working branch '${branch}' produced a conflict`,
        { stderr: merge.stderr.trim() },
      )
    }

    const prepared = await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD'])
    if (prepared.exitCode !== 0) {
      const remove = await runGit(repoPath, ['worktree', 'remove', '--force', worktreePath])
      throw new DomainError(
        'working-branch-prepare-read-failed',
        `cannot resolve detached merge result for working branch '${branch}'`,
        500,
        {
          stderr: prepared.stderr.trim(),
          cleanup: {
            worktreePath,
            worktreeRemoved: remove.exitCode === 0,
            message: remove.stderr.trim(),
          },
        },
      )
    }
    preparedCommit = prepared.stdout.trim()
    const remove = await runGit(repoPath, ['worktree', 'remove', '--force', worktreePath])
    if (remove.exitCode !== 0) {
      throw new DomainError(
        'working-branch-prepare-cleanup-incomplete',
        `detached preparation worktree for '${branch}' could not be removed`,
        500,
        { worktreePath, stderr: remove.stderr.trim() },
      )
    }
  }

  await opts.lifecycleHook?.({
    stage: 'working-branch-prepared-before-cas',
    repoPath,
    worktreePath,
    branch,
    branchRef,
    branchBefore,
    preparedCommit,
  })
  await assertWorkingBranchNotInUse(repoPath, branch, branchRef)

  // 5. The only local branch mutation. `000…` is Git's expected-missing
  // operand; omitting old-value would be an unconditional overwrite.
  const zeroOid = '0000000000000000000000000000000000000000'
  const publish = await runGit(repoPath, [
    'update-ref',
    branchRef,
    preparedCommit,
    branchBefore ?? zeroOid,
  ])
  if (publish.exitCode !== 0) {
    const current = await readLocalBranchRef(repoPath, branchRef)
    throw new ConflictError(
      'working-branch-concurrent-update',
      `working branch '${branch}' changed while its launch workspace was being prepared`,
      {
        branchRef,
        expected: branchBefore,
        current,
        preparedCommit,
        stderr: publish.stderr.trim(),
      },
    )
  }

  const provenance: WorktreeCleanupProvenance = {
    repoPath,
    worktreePath,
    branch,
    branchRef,
    branchBefore,
    branchAfter: preparedCommit,
  }

  // 6. Attach only after CAS. Failed attach rolls back exactly that CAS. A
  // raw ref writer or newly attached external worktree is preserved and
  // surfaced as incomplete cleanup.
  const add = await runGit(repoPath, ['worktree', 'add', worktreePath, branch])
  if (add.exitCode !== 0) {
    const error = mapWorktreeAddError(add.stderr, branch)
    const cleanup = await cleanupFailedWorkingBranchAttach(provenance)
    if (cleanup.failures.length > 0) {
      throw new DomainError(
        'working-branch-attach-cleanup-incomplete',
        error.message,
        500,
        cleanupFailureDetails(error, cleanup),
      )
    }
    throw error
  }

  const attachedHead = await runGit(worktreePath, ['rev-parse', '--verify', 'HEAD'])
  if (attachedHead.exitCode !== 0 || attachedHead.stdout.trim() !== preparedCommit) {
    const cleanup = await cleanupCreatedWorktree(provenance)
    throw new ConflictError(
      'working-branch-concurrent-update',
      `working branch '${branch}' changed before its launch workspace was attached`,
      {
        branchRef,
        expected: preparedCommit,
        current: attachedHead.exitCode === 0 ? attachedHead.stdout.trim() : null,
        stderr: attachedHead.stderr.trim(),
        cleanup,
      },
    )
  }
  return provenance
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
    throw new DomainError(
      'worktree-diff-failed',
      diffFailureMessage(worktreePath, tracked.stderr),
      500,
    )
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
 * wrapper-git node's `git_diff` outlet now carries this `list<path<*>>` value
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
      diffFailureMessage(worktreePath, tracked.stderr),
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
  return expandSubmodulePaths(worktreePath, fromCommit, out)
}

/**
 * RFC-210 G6 — replace a bare submodule path with the files that actually
 * changed inside it.
 *
 * A superproject reports a submodule as ONE entry (`vendor`), and
 * `ls-files --others` never looks inside one, so a `git_diff` port used to hand
 * downstream agents a directory instead of a file list — a whole submodule's
 * worth of changes collapsed into a single shard pointing at a folder.
 *
 * The diff is taken between GITLINKS, not from `submodule foreach ... status`:
 * by the time this runs the inner node's work has already been merged back and
 * the submodule working tree is CLEAN, so a porcelain-based approach reports
 * nothing at all. Comparing the baseline gitlink with the submodule's current
 * HEAD is what actually describes the change.
 *
 * Every failure mode degrades to "keep the bare path" rather than throwing —
 * `gitChangedFiles` also feeds structural diff and the RFC-098 preDirty
 * baseline, so turning a submodule edge case into an exception would take down
 * three unrelated chains.
 */
async function expandSubmodulePaths(
  worktreePath: string,
  fromCommit: string,
  paths: string[],
): Promise<string[]> {
  if (!existsSync(join(worktreePath, '.gitmodules'))) return paths
  const out: string[] = []
  for (const p of paths) {
    const subDir = join(worktreePath, p)
    // Only a directory that is itself a git work tree can be a submodule.
    if (!existsSync(join(subDir, '.git'))) {
      out.push(p)
      continue
    }
    const expanded = await submoduleChangedFiles(worktreePath, subDir, fromCommit, p)
    if (expanded === null) out.push(p)
    else out.push(...expanded)
  }
  return out
}

/** Returns `<sub>/<file>` paths, or null when the caller should keep the bare path. */
async function submoduleChangedFiles(
  worktreePath: string,
  subDir: string,
  fromCommit: string,
  subPath: string,
): Promise<string[] | null> {
  // Read the baseline gitlink from the TREE, via `ls-tree`.
  //
  // Two tempting alternatives are both wrong. `rev-parse <commit>:<path>` exits 0
  // for a plain directory as well, handing back a TREE sha that then blows up as
  // a diff endpoint ("bad object"). And `cat-file -t` cannot be used to tell the
  // two apart either: a gitlink names a commit belonging to ANOTHER repository,
  // so the superproject's object store does not have it and `cat-file` fails on
  // every submodule (measured). `ls-tree` reports mode+type straight out of the
  // tree without needing the object itself — `160000 commit` is the gitlink.
  const listed = await runGit(worktreePath, ['ls-tree', fromCommit, '--', subPath])
  if (listed.exitCode !== 0) return null
  const [meta, name] = listed.stdout.split('\n')[0]?.split('\t') ?? []
  if (meta === undefined || name === undefined) return null // absent in baseline
  const parts = meta.trim().split(/\s+/)
  if (parts[0] !== '160000' || parts[1] !== 'commit') return null // a plain directory
  const from = parts[2]
  if (from === undefined) return null

  const head = await runGit(subDir, ['rev-parse', 'HEAD'])
  if (head.exitCode !== 0) return null
  const to = head.stdout.trim()
  if (from === to) return [] // gitlink unchanged ⟹ nothing from this submodule

  const diff = await runGit(subDir, ['-c', 'core.quotepath=false', 'diff', '--name-only', from, to])
  if (diff.exitCode !== 0) return null
  const files = diff.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => `${subPath}/${l}`)
  // A gitlink that moved but produced no file delta (e.g. an empty commit) still
  // deserves a mention, so fall back to the bare path.
  return files.length > 0 ? files : null
}

/**
 * RFC-098 B3 (audit S-4) — sentinel recorded in a git wrapper's preDirty map
 * for a path that does not exist in the worktree (a deleted tracked file).
 * Compared BY STATE at finalize: pre 'deleted' ∧ post 'deleted' ⇒ subtract;
 * pre 'deleted' ∧ post has content (inner scope recreated it) ⇒ keep. A real
 * blob sha can never collide with it (shas are hex).
 */
export const DELETED_BLOB_SENTINEL = 'deleted'

/**
 * RFC-098 B3 (audit S-4) — blob hash per path: `{ path: sha | 'deleted' }`.
 * Missing files map to DELETED_BLOB_SENTINEL; existing files are hashed in
 * chunked `git hash-object -- <paths…>` batches (one spawn per 256 paths, not
 * per file). Throws DomainError('hash-object-failed') on a real git failure —
 * callers decide the degrade policy (entry capture degrades to the empty
 * pre-set; finalize fails closed with the S-24 git-diff-failed path).
 */
export async function gitBlobHashes(
  worktreePath: string,
  paths: string[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const existing: string[] = []
  for (const p of paths) {
    if (existsSync(join(worktreePath, p))) existing.push(p)
    else out[p] = DELETED_BLOB_SENTINEL
  }
  const CHUNK = 256
  for (let i = 0; i < existing.length; i += CHUNK) {
    const chunk = existing.slice(i, i + CHUNK)
    const r = await runGit(worktreePath, ['hash-object', '--', ...chunk])
    if (r.exitCode !== 0) {
      throw new DomainError(
        'hash-object-failed',
        `git hash-object failed in ${worktreePath}: ${r.stderr.trim()}`,
        500,
      )
    }
    const lines = r.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (lines.length !== chunk.length) {
      throw new DomainError(
        'hash-object-failed',
        `git hash-object returned ${lines.length} hashes for ${chunk.length} paths in ${worktreePath}`,
        500,
      )
    }
    chunk.forEach((p, idx) => {
      out[p] = lines[idx]!
    })
  }
  return out
}

/**
 * RFC-083 — worktree files containing any of the given fixed-string patterns
 * (`git grep -l --untracked -F -e p1 -e p2 ...`). Used by cross-file impact to
 * find candidate caller files for a changed method. Empty on no match / error
 * (grep exits 1 with no matches, which is not an error here).
 */
export async function gitGrepFiles(worktreePath: string, patterns: string[]): Promise<string[]> {
  if (patterns.length === 0) return []
  const args = ['-c', 'core.quotepath=false', 'grep', '-l', '--untracked', '-F']
  for (const p of patterns) args.push('-e', p)
  const r = await runGit(worktreePath, args)
  // exit 0 = matches, 1 = no matches (fine), >1 = real error → treat as empty.
  if (r.exitCode !== 0) return []
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * RFC-083 — names of files that differ between two refs (`git diff --name-only
 * <fromRef> <toRef>`). Used by the per-node structural diff to bound the
 * changed-file set between two snapshots. Throws on git failure (e.g. a pruned
 * snapshot object) so the caller can surface a typed 'pruned' status.
 */
export async function gitChangedFilesBetween(
  worktreePath: string,
  fromRef: string,
  toRef: string,
): Promise<string[]> {
  const r = await runGit(worktreePath, [
    '-c',
    'core.quotepath=false',
    'diff',
    '--name-only',
    fromRef,
    toRef,
    '--',
  ])
  if (r.exitCode !== 0) {
    throw new DomainError(
      'structural-diff-refs-failed',
      `git diff --name-only ${fromRef} ${toRef} failed: ${r.stderr.trim()}`,
      500,
    )
  }
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * RFC-083 — read a file's blob content at a given ref (`git show <ref>:<path>`).
 * Returns null when the path does not exist at that ref (e.g. a file the agent
 * added — no "before" side). Used by the structural-diff service to fetch the
 * old version of each changed file. Read-only.
 */
export async function readBlobAtRef(
  cwd: string,
  ref: string,
  relPath: string,
): Promise<string | null> {
  const r = await runGit(cwd, ['-c', 'core.quotepath=false', 'show', `${ref}:${relPath}`])
  if (r.exitCode !== 0) return null
  return r.stdout
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
 * RFC-187 §4 — count files changed in the worktree vs its base commit, INCLUDING
 * untracked (mirrors `gitDiffSnapshot`'s tracked+untracked union). Cheap boolean-ish
 * signal for "did this task produce anything": a workgroup that reaches `done` with 0
 * here yet has completed producer work leaked its outputs (probe A: fan-out writers
 * wrote outside their iso → merge-back merged nothing → canonical empty but task done).
 */
export async function worktreeFilesChanged(
  worktreePath: string,
  fromCommit: string,
): Promise<number> {
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
      diffFailureMessage(worktreePath, tracked.stderr),
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
  const names = new Set<string>()
  for (const line of tracked.stdout.split('\n')) {
    const s = line.trim()
    if (s !== '') names.add(s)
  }
  for (const line of untracked.stdout.split('\n')) {
    const s = line.trim()
    if (s !== '') names.add(s)
  }
  return names.size
}

/**
 * RFC-098 WP-9 (audit S-11): canonical ref name pinning a node_run's
 * pre-snapshot stash commit in the (shared) source-repo object database.
 * The `{taskId}` path segment exists so the worktree GC can batch-delete
 * every ref of a task with one `for-each-ref` prefix scan
 * (`deleteSnapshotRefs` below).
 */
export function snapshotRefName(taskId: string, nodeRunId: string): string {
  return `refs/agent-workflow/snapshots/${taskId}/${nodeRunId}`
}

/** Prefix under which all of a task's snapshot refs live (see snapshotRefName). */
export function snapshotRefPrefix(taskId: string): string {
  return `refs/agent-workflow/snapshots/${taskId}`
}

/**
 * RFC-098 WP-9: `git cat-file -e <sha>^{commit}` — true iff the sha resolves
 * to a commit object still present in the odb. Used as the fail-closed
 * pre-check before any destructive rollback (a gc-pruned snapshot must be
 * detected BEFORE reset+clean destroy the worktree state).
 */
export async function gitCommitExists(repoPath: string, sha: string): Promise<boolean> {
  const r = await runGit(repoPath, ['cat-file', '-e', `${sha}^{commit}`])
  return r.exitCode === 0
}

/**
 * RFC-098 WP-9: batch-delete every snapshot ref a task pinned in `repoPath`
 * (`refs/agent-workflow/snapshots/{taskId}/*`). Best-effort — `runGit` never
 * throws and a failed delete is simply not counted. Returns the number of
 * refs actually deleted. Single-repo only: multi-repo container tasks are
 * the gc.ts multi-repo blindspot (audit ⑥ gap-3 family) and are handled
 * with that fix, not here.
 */
export async function deleteSnapshotRefs(repoPath: string, taskId: string): Promise<number> {
  const list = await runGit(repoPath, [
    'for-each-ref',
    '--format=%(refname)',
    snapshotRefPrefix(taskId),
  ])
  if (list.exitCode !== 0) return 0
  const refs = list.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
  let deleted = 0
  for (const ref of refs) {
    const del = await runGit(repoPath, ['update-ref', '-d', ref])
    if (del.exitCode === 0) deleted += 1
  }
  return deleted
}

/**
 * Capture the worktree state as a git stash entry without committing it
 * (P-3-07). Returns the stash sha — caller persists it in
 * `node_runs.pre_snapshot` for later rollback on retry/resume.
 *
 * `git stash create` produces a commit object referenced only by the
 * returned sha; it does NOT push to the stash list, so concurrent stashes
 * across tasks don't fight over reflog ordering. Empty trees return ''.
 *
 * RFC-098 WP-9 (audit S-11): without a ref the stash commit is a dangling
 * object — any `git gc` past gc.pruneExpire in the SHARED source-repo odb
 * (which the platform cannot stop the user from running) destroys it and a
 * later resume loses the pre-snapshot state forever. Pass `opts.pinRef`
 * (typically `snapshotRefName(taskId, nodeRunId)`) to pin the commit with a
 * lightweight ref. Pin failure is deliberately non-blocking — the snapshot
 * is still usable short-term and failing the node over a ref write would be
 * worse than the (pre-existing) gc exposure; it is logged via `opts.log`.
 */
export async function gitStashSnapshot(
  worktreePath: string,
  opts?: { pinRef?: string; log?: Logger },
): Promise<string> {
  const r = await runGit(worktreePath, ['stash', 'create'])
  if (r.exitCode !== 0) {
    throw new DomainError('worktree-snapshot-failed', `git stash create: ${r.stderr.trim()}`, 500)
  }
  const sha = r.stdout.trim()
  if (sha !== '' && opts?.pinRef !== undefined) {
    const pin = await runGit(worktreePath, ['update-ref', opts.pinRef, sha])
    if (pin.exitCode !== 0) {
      opts.log?.warn('snapshot ref pin failed (snapshot stays gc-exposed)', {
        pinRef: opts.pinRef,
        sha,
        error: pin.stderr.trim(),
      })
    }
  }
  return sha
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
 *
 * RFC-098 WP-9 (audit S-11): fail-closed. A non-empty sha is verified with
 * `cat-file -e <sha>^{commit}` BEFORE the destructive reset+clean — the old
 * order destroyed the worktree first and only then discovered the gc-pruned
 * snapshot at the `stash apply` step ('worktree-apply-failed'), losing the
 * pre-snapshot uncommitted state forever. A missing snapshot now throws
 * `'snapshot-missing'` with the worktree untouched. The `''` path keeps its
 * reset+clean semantics unchanged (scheduler-boundary-presnapshot-rollback-
 * skip.test.ts).
 */
export async function rollbackToSnapshot(worktreePath: string, snapshotSha: string): Promise<void> {
  if (snapshotSha !== '' && !(await gitCommitExists(worktreePath, snapshotSha))) {
    throw new DomainError(
      'snapshot-missing',
      `snapshot ${snapshotSha} not found in the object database (pruned by gc?); worktree left untouched`,
      500,
    )
  }
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
  /** RFC-208: bound the underlying git so a wedged remove cannot hang a caller. */
  timeoutMs?: number
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const args = ['worktree', 'remove', opts.worktreePath]
  if (opts.force) args.push('--force')
  const r = await runGit(opts.repoPath, args, { timeoutMs: opts.timeoutMs })
  if (r.exitCode !== 0) {
    throw new DomainError(
      'worktree-remove-failed',
      `git worktree remove failed: ${r.stderr.trim()}`,
      500,
    )
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-130 — per-node isolated worktree + serial merge-back primitives.
//
// Model (design.md §2): every node run gets its own isolated worktree branched
// from a full snapshot of the canonical worktree; runs opencode in parallel;
// on success its delta is 3-way merged back into the canonical worktree under
// the task write lock. These are the low-level git primitives (T1); the
// scheduler wiring (T3) lives in services/scheduler.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** Monotonic counter for unique temp index paths (Date.now-free for determinism). */
let isoTmpIndexCounter = 0

/**
 * RFC-130 pin-ref name for an isolated run's base / node snapshot (D26: base and
 * node use DISTINCT refs so the success path pinning `node` never clobbers `base`,
 * both survive for pending-merge replay until the run is merged).
 */
export function isoRefName(taskId: string, nodeRunId: string, kind: 'base' | 'node'): string {
  return `refs/agent-workflow/iso/${taskId}/${nodeRunId}/${kind}`
}

/** All RFC-130 iso refs for a task (GC / cleanup glob root). */
export function isoRefGlob(taskId: string): string {
  return `refs/agent-workflow/iso/${taskId}`
}

/**
 * RFC-130 D2/D25: snapshot a worktree's FULL current state (HEAD + all tracked
 * modifications + ALL untracked files) as a commit object, WITHOUT touching the
 * worktree, the real index, or HEAD. Uses a throwaway temp index via
 * `GIT_INDEX_FILE`. Optionally pins the commit with `update-ref` so gc cannot
 * prune it during a long-running agent.
 *
 * Unlike `gitStashSnapshot` (`git stash create`, which OMITS untracked files),
 * this includes untracked — required both for the isolation base (the agent must
 * see the full canonical state incl. untracked upstream outputs) and for the node
 * snapshot (a node's new files are untracked in its iso worktree).
 */
/**
 * RFC-130 D22 — does the worktree have submodule(s) with UNCOMMITTED CONTENT (edits
 * inside a submodule's own working tree)? `snapshotFullState` captures only the
 * parent's gitlink commit for a submodule, NOT uncommitted content inside it, so
 * such edits would be SILENTLY LOST on merge-back. Callers fail loudly instead.
 * Fast path: a repo with no submodules returns false without the per-submodule scan.
 */
export async function hasDirtySubmoduleContent(worktreePath: string): Promise<boolean> {
  // RFC-210 AC-11/AC-12: gate on the filesystem probe FIRST. Every other
  // submodule-aware path in the platform starts with `detectSubmodules`
  // (`existsSync('.gitmodules')`, zero processes); this one used to spawn
  // `submodule status --recursive` unconditionally, so a repo with no
  // submodules — the overwhelming majority — paid one git process per call
  // and `gitRecurseSubmodules='never'` could not reach "zero submodule argv".
  // Duplicated inline rather than imported: services/gitSubmodule.ts imports
  // this module, so the edge only goes one way (util/git.ts reaches it via
  // dynamic import).
  if (!existsSync(join(worktreePath, '.gitmodules'))) return false
  const status = await runGit(worktreePath, ['submodule', 'status', '--recursive'])
  if (status.exitCode !== 0 || status.stdout.trim() === '') return false // no submodules
  // Ask each submodule (recursively) for its own dirty/untracked porcelain. --quiet
  // suppresses the "Entering '<path>'" banner, so any stdout ⟹ a dirty submodule.
  const r = await runGit(worktreePath, [
    'submodule',
    'foreach',
    '--quiet',
    '--recursive',
    'git status --porcelain --untracked-files=all',
  ])
  return r.stdout.trim() !== ''
}

export async function snapshotFullState(
  worktreePath: string,
  opts?: {
    pinRef?: string
    log?: Logger
    /**
     * RFC-193 K1 必达：`add -A` 之后逐路径 `git add -f`（同一临时 index），把
     * gitignored 的 path 端口源文件强制收进快照。带 GIT_LITERAL_PATHSPECS=1 —
     * `--` 只终止选项解析、不关闭 pathspec magic，`:` 开头的合法文件名会被当
     * `:(glob)` 等模式解释（Codex 设计门 P2）。单路径失败降级 warn（文件可能
     * 已被后续节点删除——快照如实反映；阅读语义有归档兜底）。
     */
    forceIncludePaths?: string[]
  },
): Promise<string> {
  const tmpIndex = join(tmpdir(), `aw-iso-index-${process.pid}-${isoTmpIndexCounter++}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    const seed = await runGit(worktreePath, ['read-tree', 'HEAD'], { env })
    if (seed.exitCode !== 0) {
      throw new DomainError('iso-snapshot-failed', `read-tree HEAD: ${seed.stderr.trim()}`, 500)
    }
    const add = await runGit(worktreePath, ['add', '-A'], { env })
    if (add.exitCode !== 0) {
      throw new DomainError('iso-snapshot-failed', `add -A: ${add.stderr.trim()}`, 500)
    }
    for (const p of opts?.forceIncludePaths ?? []) {
      const forced = await runGit(worktreePath, ['add', '-f', '--', p], {
        env: { ...env, GIT_LITERAL_PATHSPECS: '1' },
      })
      if (forced.exitCode !== 0) {
        opts?.log?.warn('snapshot force-include path failed (skipped)', {
          path: p,
          error: forced.stderr.trim(),
        })
      }
    }
    const writeTree = await runGit(worktreePath, ['write-tree'], { env })
    if (writeTree.exitCode !== 0) {
      throw new DomainError('iso-snapshot-failed', `write-tree: ${writeTree.stderr.trim()}`, 500)
    }
    const tree = writeTree.stdout.trim()
    const commit = await runGit(
      worktreePath,
      ['commit-tree', tree, '-p', 'HEAD', '-m', 'aw-iso-snapshot'],
      // RFC-130: internal snapshot commit must not depend on ambient git identity
      // (a URL-cloned worktree has none; some CI runners can't auto-detect one).
      { env: AW_INTERNAL_GIT_IDENTITY },
    )
    if (commit.exitCode !== 0) {
      throw new DomainError('iso-snapshot-failed', `commit-tree: ${commit.stderr.trim()}`, 500)
    }
    const sha = commit.stdout.trim()
    if (opts?.pinRef !== undefined) {
      const pin = await runGit(worktreePath, ['update-ref', opts.pinRef, sha])
      if (pin.exitCode !== 0) {
        opts.log?.warn('iso snapshot ref pin failed (snapshot stays gc-exposed)', {
          pinRef: opts.pinRef,
          sha,
          error: pin.stderr.trim(),
        })
      }
    }
    return sha
  } finally {
    await unlink(tmpIndex).catch(() => {
      /* best-effort: temp index may not exist if read-tree failed */
    })
  }
}

export interface CreateIsolatedWorktreeOptions {
  repoPath: string
  /** Absolute path OUTSIDE the canonical worktree (D14). */
  isoPath: string
  /** Full-state snapshot commit of the canonical worktree at dispatch. */
  baseSnapshotCommit: string
  /** The canonical worktree's HEAD commit (task base) — iso HEAD resets here. */
  taskBaseHead: string
  submoduleMode?: 'auto' | 'always' | 'never'
  submoduleJobs?: number
}

/**
 * RFC-130 D23/D28: create an isolated worktree whose WORKING TREE equals the
 * full-state snapshot but whose HEAD/index are the task base — so the accumulated
 * upstream changes appear as UNSTAGED modifications (plain `git diff` / `status`
 * behave exactly like today's shared worktree, preserving inspect-diff agents).
 *
 *   git worktree add --detach <iso> <baseSnapshotCommit>  // net checkout (incl deletions)
 *   git reset --mixed <taskBaseHead>                       // HEAD+index→base, worktree stays
 *
 * `--mixed` (NOT `--soft`): soft would leave everything staged so plain `git diff`
 * shows nothing. Then submodules are synced (D20) so submodule working dirs match.
 */
export async function createIsolatedWorktree(opts: CreateIsolatedWorktreeOptions): Promise<void> {
  const add = await runGit(opts.repoPath, [
    'worktree',
    'add',
    '--detach',
    opts.isoPath,
    opts.baseSnapshotCommit,
  ])
  if (add.exitCode !== 0) {
    throw new DomainError(
      'iso-worktree-add-failed',
      `git worktree add (iso): ${add.stderr.trim()}`,
      500,
    )
  }
  const reset = await runGit(opts.isoPath, ['reset', '--mixed', opts.taskBaseHead])
  if (reset.exitCode !== 0) {
    throw new DomainError(
      'iso-worktree-reset-failed',
      `git reset --mixed (iso): ${reset.stderr.trim()}`,
      500,
    )
  }
  // D20: worktree add does not populate submodule working dirs — sync like createWorktree.
  const { syncSubmodules } = await import('@/services/gitSubmodule')
  const { resolveSubmoduleParams } = await import('@/services/gitRepoCache')
  const effective = resolveSubmoduleParams(opts.submoduleMode, opts.submoduleJobs)
  await syncSubmodules(opts.isoPath, { mode: effective.mode, jobs: effective.jobs })
}

export interface MergeTreeResult {
  /** Merged tree OID (present even when conflicts is non-empty). */
  mergedTree: string
  /** Conflicted paths reported by merge-tree (empty ⟹ clean auto-merge). */
  conflicts: string[]
  /**
   * Full `git merge-tree` stdout including the `CONFLICT (<class>): ...` info
   * messages (RFC-130 §6.2③). Downstream (mergeAgent.parseConflictManifest)
   * classifies the conflict CLASS from this — content conflicts carry text
   * markers, but modify-delete/rename-delete/binary/submodule are SILENT and can
   * only be recovered from these messages. Empty tail when the merge is clean.
   */
  rawConflictOutput: string
}

/**
 * RFC-130 D3: in-memory 3-way merge via `git merge-tree --write-tree` (git ≥ 2.38,
 * D7). Produces a merged tree OID + conflicted-path list WITHOUT touching any
 * worktree. base = the node's isolation snapshot; ours = canonical NOW; theirs =
 * the node's final iso snapshot. Empty `conflicts` ⟹ clean → materialize directly.
 *
 * NOTE: intentionally NOT `--name-only` — that flag suppresses the
 * `CONFLICT (<class>)` info messages we need to classify silent conflicts
 * (§6.2③). Without it, the lines after the tree OID up to the first blank line
 * are the conflicted-file-info stanzas (`<mode> <oid> <stage>\t<path>`), from
 * which we recover the (deduped) conflicted paths; the blank-line-separated tail
 * carries the human-readable CONFLICT messages, preserved in `rawConflictOutput`.
 */
export async function mergeTreeInMemory(
  repoPath: string,
  opts: { base: string; ours: string; theirs: string },
): Promise<MergeTreeResult> {
  const r = await runGit(repoPath, [
    'merge-tree',
    '--write-tree',
    `--merge-base=${opts.base}`,
    opts.ours,
    opts.theirs,
  ])
  // exit 0 = clean, 1 = conflicts (tree still emitted on line 1), >1 = error.
  if (r.exitCode > 1) {
    throw new DomainError('merge-tree-failed', `git merge-tree: ${r.stderr.trim()}`, 500)
  }
  const lines = r.stdout.split('\n')
  const mergedTree = (lines[0] ?? '').trim()
  if (mergedTree === '') {
    throw new DomainError('merge-tree-failed', 'git merge-tree produced no tree oid', 500)
  }
  // Conflicted-file-info stanzas run from line 1 until the first blank line;
  // each is `<mode> <oid> <stage>\t<path>` (a path recurs across stages 1/2/3).
  const paths = new Set<string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line === '') break // blank line separates stanzas from CONFLICT messages
    const tab = line.indexOf('\t')
    if (tab >= 0) paths.add(line.slice(tab + 1))
  }
  return { mergedTree, conflicts: [...paths], rawConflictOutput: r.stdout }
}

/**
 * RFC-187 §4-2 — the SALVAGE tree of a conflicted 3-way merge: start from the
 * conflicted `mergedTree` and revert every conflicted path to its `ours` entry
 * (ours blob/gitlink restored; path deleted when ours lacks it). Materializing
 * the result lands every cleanly-merged path NOW while each conflicted path
 * stays exactly as canonical has it — the conflict remains for the merge agent
 * / human, but clean sibling work is no longer held hostage by whole-repo
 * all-or-nothing merge-back (workgroup-e2e-audit §4-2: N-way fan-out used to
 * drop the loser's ENTIRE delta).
 *
 * FAIL-CLOSED: returns null (caller keeps today's withhold-everything path)
 * whenever a conflicted path involves a DIRECTORY entry on either side
 * (file↔dir / rename family — index surgery there is not a plain entry swap).
 * Plain content / modify-delete / binary / gitlink conflicts all salvage.
 *
 * Returns the salvage tree + the paths it actually lands relative to `oursTree`
 * (empty ⇒ nothing clean to land — the caller can skip materialize entirely).
 */
export async function buildSalvageTree(
  repoPath: string,
  opts: {
    /** Conflicted merge tree from `mergeTreeInMemory`. */
    mergedTree: string
    /** `ours` commit (canonical snapshot the merge ran against). */
    ours: string
    /** Conflicted paths reported by `mergeTreeInMemory`. */
    conflicts: string[]
  },
): Promise<{ tree: string; landedPaths: string[] } | null> {
  if (opts.conflicts.length === 0) return null
  const infoLines: string[] = []
  for (const p of opts.conflicts) {
    const inOurs = await runGit(repoPath, ['ls-tree', opts.ours, '--', p])
    if (inOurs.exitCode !== 0) {
      throw new DomainError('salvage-tree-failed', `ls-tree ours: ${inOurs.stderr.trim()}`, 500)
    }
    const inMerged = await runGit(repoPath, ['ls-tree', opts.mergedTree, '--', p])
    if (inMerged.exitCode !== 0) {
      throw new DomainError('salvage-tree-failed', `ls-tree merged: ${inMerged.stderr.trim()}`, 500)
    }
    // Directory entry on either side ⇒ exotic conflict class — fail closed.
    if (/^\d+ tree /m.test(inOurs.stdout) || /^\d+ tree /m.test(inMerged.stdout)) return null
    const oursLine = inOurs.stdout.trimEnd()
    if (oursLine === '') {
      // Absent in ours → revert = delete from the merged tree (mode 0 removes).
      infoLines.push(`0 ${'0'.repeat(40)}\t${p}`)
    } else {
      // `ls-tree` line format is accepted verbatim by `update-index --index-info`.
      infoLines.push(oursLine)
    }
  }
  const tmpIndex = join(tmpdir(), `aw-salvage-index-${process.pid}-${isoTmpIndexCounter++}`)
  const env = { GIT_INDEX_FILE: tmpIndex }
  try {
    const seed = await runGit(repoPath, ['read-tree', opts.mergedTree], { env })
    if (seed.exitCode !== 0) {
      throw new DomainError('salvage-tree-failed', `read-tree: ${seed.stderr.trim()}`, 500)
    }
    const surgery = await runGit(repoPath, ['update-index', '--index-info'], {
      env,
      stdin: infoLines.join('\n') + '\n',
    })
    if (surgery.exitCode !== 0) {
      throw new DomainError('salvage-tree-failed', `index-info: ${surgery.stderr.trim()}`, 500)
    }
    const writeTree = await runGit(repoPath, ['write-tree'], { env })
    if (writeTree.exitCode !== 0) {
      throw new DomainError('salvage-tree-failed', `write-tree: ${writeTree.stderr.trim()}`, 500)
    }
    const tree = writeTree.stdout.trim()
    const oursTree = (await runGit(repoPath, ['rev-parse', `${opts.ours}^{tree}`])).stdout.trim()
    const landed =
      tree === oursTree
        ? []
        : (await runGit(repoPath, ['diff', '--name-only', oursTree, tree])).stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l !== '')
    return { tree, landedPaths: landed }
  } finally {
    await unlink(tmpIndex).catch(() => {
      /* best-effort */
    })
  }
}

/** RFC-130 P2-2: wrap a tree OID in a commit so `git worktree add` (which needs a
 *  commit-ish) can seed a resolver worktree from it. */
export async function commitTree(
  repoPath: string,
  treeOid: string,
  parentCommit: string,
  message: string,
): Promise<string> {
  const r = await runGit(repoPath, ['commit-tree', treeOid, '-p', parentCommit, '-m', message], {
    // RFC-130: internal merge-resolution / shard-replacement commit — fixed identity
    // (independent of the worktree/host git config, same rationale as snapshotFullState).
    env: AW_INTERNAL_GIT_IDENTITY,
  })
  if (r.exitCode !== 0) {
    throw new DomainError('commit-tree-failed', `git commit-tree: ${r.stderr.trim()}`, 500)
  }
  return r.stdout.trim()
}

/** RFC-130 D30: pure oracle — does the text contain a residual git conflict marker?
 *  (Content conflicts only; modify-delete/binary/submodule leave NO markers, so
 *  this is a fast pre-check, NOT the authoritative resolution check.) */
export function residualConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})(\s|$)/m.test(text)
}

/**
 * RFC-130 §5.3 / D28: make the canonical worktree's working tree equal `mergedTree`
 * while keeping HEAD at `taskBaseHead`, leaving the delta UNSTAGED (I-2 "uncommitted
 * = product"). Robustly handles deletions and file↔dir replacements (Codex gate
 * 五/六轮): remove D/T paths AND any worktree path blocking an added file BEFORE
 * checkout, then refresh submodule working dirs for changed gitlinks (D20/D22).
 */
export async function materializeTree(
  worktreePath: string,
  opts: {
    mergedTree: string
    canonCurrentTree: string
    taskBaseHead: string
    submoduleMode?: 'auto' | 'always' | 'never'
    submoduleJobs?: number
    log?: Logger
  },
): Promise<void> {
  // ① removals (deleted + type-changed) — checkout-index never deletes.
  const removed = await gitDiffNames(worktreePath, opts.canonCurrentTree, opts.mergedTree, 'DT')
  for (const p of removed) {
    await rm(join(worktreePath, p), { recursive: true, force: true })
  }
  // ② added paths: remove any worktree DIR blocking a new file (dir→file replace).
  const added = await gitDiffNames(worktreePath, opts.canonCurrentTree, opts.mergedTree, 'A')
  for (const p of added) {
    const abs = join(worktreePath, p)
    const st = await stat(abs).catch(() => null)
    if (st?.isDirectory() === true) {
      await rm(abs, { recursive: true, force: true })
    }
  }
  // ③ write the merged tree into index + worktree.
  const readTree = await runGit(worktreePath, ['read-tree', opts.mergedTree])
  if (readTree.exitCode !== 0) {
    throw new DomainError('materialize-failed', `read-tree: ${readTree.stderr.trim()}`, 500)
  }
  const checkout = await runGit(worktreePath, ['checkout-index', '-f', '-a'])
  if (checkout.exitCode !== 0) {
    throw new DomainError('materialize-failed', `checkout-index: ${checkout.stderr.trim()}`, 500)
  }
  // ④ index → base so the delta is UNSTAGED (worktree unchanged = merged tree).
  const reset = await runGit(worktreePath, ['reset', '--mixed', opts.taskBaseHead])
  if (reset.exitCode !== 0) {
    throw new DomainError('materialize-failed', `reset --mixed: ${reset.stderr.trim()}`, 500)
  }
  // ⑤ refresh submodule working dirs for any changed gitlink (D20/D22).
  const { syncSubmodules } = await import('@/services/gitSubmodule')
  const { resolveSubmoduleParams } = await import('@/services/gitRepoCache')
  const effective = resolveSubmoduleParams(opts.submoduleMode, opts.submoduleJobs)
  const synced = await syncSubmodules(worktreePath, { mode: effective.mode, jobs: effective.jobs })
  if (!synced.ok) {
    // RFC-210: this return value used to be discarded, which is part of why the
    // gitlink loss below stayed invisible for so long.
    opts.log?.warn('submodule sync during materialize failed', {
      worktreePath,
      error: synced.error ?? '',
    })
  }
  // ⑥ RFC-210: re-point each submodule at the gitlink the MERGED tree records.
  //
  // Must come AFTER ⑤, not before: `submodule update` checks out whatever the
  // INDEX says, and ④ just reset the index back to the task base — so any
  // gitlink placed here beforehand is immediately undone. (Written the other way
  // round first; only a real-git run surfaced it.)
  //
  // Without this step the whole merge result for a submodule is silently thrown
  // away: `checkout-index` in ③ never writes gitlinks, so ⑤ leaves the submodule
  // sitting at the base commit and the superproject looks untouched.
  await checkoutMergedGitlinks(worktreePath, opts.mergedTree, effective, opts.log)
}

/**
 * RFC-210 — walk the merged tree's gitlinks and check each submodule out to the
 * commit the merge decided on.
 *
 * Recurses by hand because `git ls-tree -r` cannot see through a gitlink (it is
 * a commit object belonging to another repository), so nested submodules are
 * invisible to a single listing. Each level is read from its own parent.
 *
 * Failure modes are deliberately split:
 *  - the object is missing ⟹ THROW. It means the publish step never ran for this
 *    commit, and continuing would leave canonical pointing at an unreachable
 *    object — the superproject's `git status` would then fail outright.
 *  - the submodule working tree is dirty ⟹ force the checkout after snapshotting
 *    is the caller's job; here we retry with `-f` and only warn if that also
 *    fails. Turning "user left edits in a submodule" into a hard merge-back
 *    failure would just move RFC-130 D22's block to a later, more expensive point.
 */
async function checkoutMergedGitlinks(
  worktreePath: string,
  tree: string,
  effective: { mode: 'auto' | 'always' | 'never'; jobs: number },
  log?: Logger,
  prefix = '',
): Promise<void> {
  if (effective.mode === 'never') return
  const listed = await runGit(worktreePath, ['ls-tree', tree])
  if (listed.exitCode !== 0) return
  for (const line of listed.stdout.split('\n')) {
    // `<mode> <type> <sha>\t<name>`; gitlinks are type `commit`.
    const [meta, name] = line.split('\t')
    if (meta === undefined || name === undefined) continue
    const parts = meta.trim().split(/\s+/)
    if (parts[1] !== 'commit') continue
    const sha = parts[2]
    if (sha === undefined) continue
    const relPath = prefix === '' ? name : `${prefix}/${name}`
    const subPath = join(worktreePath, name)
    if (!existsSync(subPath)) continue // uninitialized — nothing to move
    const co = await runGit(subPath, ['checkout', '--detach', sha])
    if (co.exitCode !== 0) {
      const stderr = co.stderr.trim()
      if (/would be overwritten|local changes/i.test(stderr)) {
        const forced = await runGit(subPath, ['checkout', '--detach', '-f', sha])
        if (forced.exitCode !== 0) {
          log?.warn('submodule gitlink checkout failed on dirty worktree', {
            subPath: relPath,
            sha,
            error: forced.stderr.trim(),
          })
          continue
        }
      } else {
        throw new DomainError(
          'materialize-failed',
          `submodule '${relPath}' cannot be moved to ${sha}: ${stderr}`,
          500,
        )
      }
    }
    // Recurse: this submodule may itself contain submodules, and their gitlinks
    // live in ITS tree, not the one we just listed.
    const subTree = await runGit(subPath, ['rev-parse', `${sha}^{tree}`])
    if (subTree.exitCode === 0) {
      await checkoutMergedGitlinks(subPath, subTree.stdout.trim(), effective, log, relPath)
    }
  }
}

/** `git diff --name-only --diff-filter=<filter> <from> <to>` (RFC-130 materialize helper). */
async function gitDiffNames(
  worktreePath: string,
  from: string,
  to: string,
  filter: string,
): Promise<string[]> {
  const r = await runGit(worktreePath, ['diff', '--name-only', `--diff-filter=${filter}`, from, to])
  if (r.exitCode !== 0) {
    throw new DomainError('materialize-failed', `diff --name-only: ${r.stderr.trim()}`, 500)
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
}

/** RFC-130: delete both iso pin refs (base + node) for a completed run. */
export async function deleteIsoRefs(
  repoPath: string,
  taskId: string,
  nodeRunId: string,
  opts?: { timeoutMs?: number },
): Promise<void> {
  for (const kind of ['base', 'node'] as const) {
    await runGit(repoPath, ['update-ref', '-d', isoRefName(taskId, nodeRunId, kind)], {
      timeoutMs: opts?.timeoutMs,
    })
  }
}
