// RFC-024: persistent Git URL → local mirror cache.
//
// Responsibilities:
//   - `resolveCachedRepo`: ensure a usable local clone exists for a given URL.
//     Cold path runs `git clone`; warm path optionally `git fetch` and returns
//     the existing cache dir.
//   - `listCachedRepos` / `refreshCachedRepo` / `deleteCachedRepo`: backing
//     ops for the `/api/cached-repos` management surface.
//
// Concurrency: same-URL clones are serialized via an in-process mutex map so
// two concurrent launches against a cold URL can't race on the same target
// directory. The mutex also bounds the second caller's wait under the
// configured `gitCloneTimeoutMs`.
//
// Logging / errors: any stderr fragment that may contain a credential-bearing
// URL is run through `redactGitUrl` before it leaves this module (logs, error
// bodies, DB rows).

import {
  type CachedRepo,
  gitUrlCacheKeyWith,
  parseGitUrl,
  redactGitUrl,
} from '@agent-workflow/shared'
import { eq, sql } from 'drizzle-orm'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { cachedRepos, tasks } from '@/db/schema'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { classifyBaseRef, nonInteractiveGitEnv, runGit } from '@/util/git'
import { createLogger } from '@/util/log'
import { Paths } from '@/util/paths'
import { getCachedGitCapabilities } from '@/services/gitVersion'
import { detectSubmodules, syncSubmodules, type SubmoduleMode } from '@/services/gitSubmodule'

const log = createLogger('git-repo-cache')

const DEFAULT_CLONE_TIMEOUT_MS = 30 * 60 * 1000

const sha1Hex = (s: string) => createHash('sha1').update(s).digest('hex')

/** Per-URL serialization. Same urlHash → second caller awaits the first. */
const urlMutex = new Map<string, Promise<unknown>>()

async function withUrlLock<T>(urlHash: string, fn: () => Promise<T>): Promise<T> {
  const prev = urlMutex.get(urlHash) ?? Promise.resolve()
  let release!: () => void
  const slot = new Promise<void>((resolve) => {
    release = resolve
  })
  urlMutex.set(
    urlHash,
    prev.then(() => slot),
  )
  try {
    await prev
    return await fn()
  } finally {
    release()
    // Best-effort cleanup: if no one queued behind us, drop the map entry.
    if (urlMutex.get(urlHash) === prev.then(() => slot)) {
      urlMutex.delete(urlHash)
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let to: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    to = setTimeout(
      () =>
        reject(
          new DomainError('repo-cache-locked', `${label} timed out after ${ms}ms`, 504, undefined),
        ),
      ms,
    )
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (to) clearTimeout(to)
  }
}

/**
 * Bun-spawn wrapper for a `git` command that runs without a fixed cwd
 * (e.g. `git clone <url> <dir>`). Mirrors `runGit`'s return shape.
 */
async function spawnGit(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    // Explicit env passthrough — see runGit() in util/git.ts for rationale.
    // nonInteractiveGitEnv() also stops ssh from hanging the daemon on first
    // connect to an unknown host (ssh reads /dev/tty, not stdin, for prompts).
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

export interface GitRepoCacheDeps {
  db: DbClient
  /** Override app home (tests). Defaults to Paths.root. */
  appHome?: string
  /** Mutex + clone/fetch wait budget in ms. Default 30 min. */
  cloneTimeoutMs?: number
  /** If true, `git fetch` runs whenever a cache row is reused. Default true. */
  fetchOnReuse?: boolean
  /** Override now() for deterministic tests. */
  now?: () => number
  // --- RFC-034 submodule recursion ---
  /**
   * Behavior for cold clone / warm fetch submodule passes. Default 'auto'.
   * Callers (settings reader) pass through the global config value. Effective
   * mode is further clamped by local git capabilities (see resolveSubmoduleMode).
   */
  submoduleMode?: SubmoduleMode
  /**
   * `--jobs N` for clone / sync / update. Default 4. Clamped to 1 when the
   * local git is older than 2.13.
   */
  submoduleJobs?: number
  /**
   * RFC-068 — branches to fast-forward to `origin/<branch>` on warm path
   * after fetch. Caller passes the launcher-selected base ref (when it's a
   * branch name) plus the detected default branch. tag / sha / remote-
   * tracking refs are skipped automatically via `classifyBaseRef`. Empty /
   * undefined → no FF (cold clones skip FF unconditionally since they're
   * already at origin/HEAD).
   */
  syncBranches?: string[]
}

export interface ResolveCachedRepoInput {
  url: string
}

export interface ResolveCachedRepoResult {
  cached: CachedRepo
  cold: boolean
  fetchOk: boolean
  fetchError: string | null
  /** RFC-034: outcome of the submodule sync/init pass on this resolve. */
  submoduleSyncOk: boolean
  submoduleSyncError: string | null
  hasSubmodules: boolean
  /**
   * RFC-068 — fast-forward outcomes on warm path. Empty on cold path. Each
   * entry corresponds to one branch from `deps.syncBranches` (after filtering
   * via `classifyBaseRef`). Caller uses the redacted form to emit a task
   * warning event when interesting.
   */
  ffOutcomes: FastForwardOutcome[]
}

export interface FastForwardOutcome {
  branch: string
  /** True iff `refs/heads/<branch>` actually moved (origin advanced). */
  advanced: boolean
  /** Pre-FF sha; null if branch didn't exist locally. */
  fromSha: string | null
  /** Post-FF sha; null if FF failed or origin/<branch> doesn't exist. */
  toSha: string | null
  /** Redacted stderr / explanation when FF was attempted but couldn't proceed. */
  warning: string | null
}

function rowToCached(row: typeof cachedRepos.$inferSelect, referencingTaskCount = 0): CachedRepo {
  return {
    id: row.id,
    url: row.url,
    urlRedacted: redactGitUrl(row.url),
    localPath: row.localPath,
    defaultBranch: row.defaultBranch ?? null,
    lastFetchedAt: new Date(row.lastFetchedAt).toISOString(),
    createdAt: new Date(row.createdAt).toISOString(),
    referencingTaskCount,
    hasSubmodules: row.hasSubmodules ?? null,
    lastSubmoduleSyncOk: row.lastSubmoduleSyncOk ?? null,
    lastSubmoduleSyncError: row.lastSubmoduleSyncError ?? null,
  }
}

/**
 * RFC-068 — fast-forward `refs/heads/<branch>` to `refs/remotes/origin/<branch>`
 * in a mirror cache repo. Caller MUST hold withUrlLock(hash) for the cacheDir.
 *
 * `git update-ref` is preferred over `git pull` here because the mirror's
 * working tree is never used at runtime (worker processes get their own
 * worktrees via `git worktree add`), so there's no value in checking files
 * out — that would only risk locking other concurrent worktree operations.
 *
 * Returns FastForwardOutcome documenting whether the ref moved, plus any
 * warning string when the FF could not proceed (origin/<branch> missing,
 * non-FF divergence, etc.). On warning the caller falls back to using the
 * remote-tracking ref directly.
 */
export async function syncBranchToRemote(
  cacheDir: string,
  branch: string,
): Promise<FastForwardOutcome> {
  if (branch === '' || branch === 'HEAD') {
    return { branch, advanced: false, fromSha: null, toSha: null, warning: 'invalid-branch' }
  }
  // Resolve origin/<branch>; missing → skip (mirror may have a branch with no
  // upstream, like detached HEAD configs).
  const originRef = `refs/remotes/origin/${branch}`
  const originSha = await runGit(cacheDir, ['rev-parse', '--verify', `${originRef}^{commit}`])
  if (originSha.exitCode !== 0) {
    return {
      branch,
      advanced: false,
      fromSha: null,
      toSha: null,
      warning: 'origin-ref-missing',
    }
  }
  const target = originSha.stdout.trim()

  // Local sha (may not exist if branch was never checked out — that's fine,
  // update-ref will create it).
  const localRef = `refs/heads/${branch}`
  const localShaRes = await runGit(cacheDir, ['rev-parse', '--verify', `${localRef}^{commit}`])
  const fromSha = localShaRes.exitCode === 0 ? localShaRes.stdout.trim() : null

  if (fromSha === target) {
    return { branch, advanced: false, fromSha, toSha: target, warning: null }
  }

  // Mirror caches are platform-exclusive: no hand-commits land in
  // refs/heads/<branch> beyond what fetch did, so a non-FF should never
  // happen. Still: when fromSha exists, gate the update with `--create-reflog`
  // + the previous oldvalue so a surprise divergence is reported, not
  // silently overwritten.
  const args = ['update-ref', '--create-reflog', localRef, target]
  if (fromSha !== null) args.push(fromSha)
  const upd = await runGit(cacheDir, args)
  if (upd.exitCode !== 0) {
    return {
      branch,
      advanced: false,
      fromSha,
      toSha: null,
      warning: upd.stderr.trim() || 'update-ref-failed',
    }
  }
  return { branch, advanced: true, fromSha, toSha: target, warning: null }
}

/**
 * Resolve effective submodule mode + jobs from caller config + local git caps.
 * Pre-2.5 git can't run worktree+submodule reliably → force never.
 * Pre-2.13 git lacks `--jobs` → clamp to 1.
 */
export function resolveSubmoduleParams(
  inMode: SubmoduleMode | undefined,
  inJobs: number | undefined,
): { mode: SubmoduleMode; jobs: number } {
  const caps = getCachedGitCapabilities()
  let mode: SubmoduleMode = inMode ?? 'auto'
  if (caps && !caps.supportsRecurseInWorktree) {
    mode = 'never'
  }
  let jobs = Math.max(1, Math.min(32, Math.floor(inJobs ?? 4)))
  if (caps && !caps.supportsSubmoduleJobs) {
    jobs = 1
  }
  return { mode, jobs }
}

async function detectDefaultBranchInRepo(dir: string): Promise<string | null> {
  const sym = await runGit(dir, ['symbolic-ref', '--short', 'HEAD'])
  if (sym.exitCode === 0) {
    const v = sym.stdout.trim()
    if (v.length > 0 && v !== 'HEAD') return v
  }
  // Fallback to origin/HEAD when local HEAD is detached.
  const origin = await runGit(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (origin.exitCode === 0) {
    const v = origin.stdout.trim().replace(/^origin\//, '')
    if (v.length > 0) return v
  }
  return null
}

async function isValidGitDir(dir: string): Promise<boolean> {
  if (!existsSync(dir)) return false
  const r = await runGit(dir, ['rev-parse', '--git-dir'])
  return r.exitCode === 0
}

export async function resolveCachedRepo(
  deps: GitRepoCacheDeps,
  input: ResolveCachedRepoInput,
): Promise<ResolveCachedRepoResult> {
  const parsed = parseGitUrl(input.url)
  if (!parsed) {
    throw new ValidationError('repo-url-invalid', 'unsupported or malformed Git URL', {
      url: redactGitUrl(input.url),
    })
  }
  const { hash, slug } = gitUrlCacheKeyWith(parsed, sha1Hex)
  const appHome = deps.appHome ?? Paths.root
  const cacheRoot = join(appHome, 'repos')
  const cacheDir = join(cacheRoot, `${hash}-${slug}`)
  const now = deps.now ?? Date.now
  const timeoutMs = deps.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS
  const fetchOnReuse = deps.fetchOnReuse ?? true
  const redacted = redactGitUrl(input.url)
  const submodule = resolveSubmoduleParams(deps.submoduleMode, deps.submoduleJobs)

  const work = withUrlLock(hash, async () => {
    const existing = deps.db
      .select()
      .from(cachedRepos)
      .where(eq(cachedRepos.urlHash, hash))
      .limit(1)
      .all()
    const row = existing[0]

    if (row && (await isValidGitDir(row.localPath))) {
      // Warm path.
      let fetchOk = true
      let fetchError: string | null = null
      if (fetchOnReuse) {
        const r = await runGit(row.localPath, ['fetch', '--all', '--prune', '--tags'])
        if (r.exitCode !== 0) {
          fetchOk = false
          fetchError = redactGitUrl(r.stderr.trim())
          log.warn('git fetch on reuse failed', { url: redacted, stderr: fetchError })
        }
      }
      // RFC-068: fast-forward each requested base branch to its origin
      // tracking ref so `git rev-parse <branch>` downstream picks up the
      // freshly-fetched commit. tag / sha / origin-tracking refs are
      // filtered out via classifyBaseRef (no FF applicable). Failures are
      // surfaced as warnings; caller may fall back to origin/<branch>
      // directly. Whole FF block is best-effort — skipped entirely when
      // fetch failed (no new origin commits to FF to).
      const ffOutcomes: FastForwardOutcome[] = []
      if (fetchOk) {
        const seen = new Set<string>()
        for (const candidate of deps.syncBranches ?? []) {
          if (seen.has(candidate)) continue
          seen.add(candidate)
          const kind = await classifyBaseRef(row.localPath, candidate)
          if (kind !== 'branch' && kind !== 'unknown') continue
          const outcome = await syncBranchToRemote(row.localPath, candidate)
          ffOutcomes.push(outcome)
          if (outcome.warning !== null) {
            log.warn('rfc068/ff-failed', {
              url: redacted,
              branch: candidate,
              warning: outcome.warning,
            })
          } else if (outcome.advanced) {
            log.info('rfc068/ff-advanced', {
              url: redacted,
              branch: candidate,
              fromSha: outcome.fromSha,
              toSha: outcome.toSha,
            })
          }
        }
      }
      // RFC-034: refresh submodule working dirs to whatever the parent's
      // gitlink pointers say. Failures here are warnings — fetch is still
      // considered successful and `last_fetched_at` still advances.
      const sub = await syncSubmodules(row.localPath, {
        mode: submodule.mode,
        jobs: submodule.jobs,
      })
      if (!sub.ok) {
        log.warn('submodule sync on reuse failed', {
          url: redacted,
          stderr: sub.error ?? '',
        })
      }
      const ts = now()
      deps.db
        .update(cachedRepos)
        .set({
          lastFetchedAt: ts,
          hasSubmodules: sub.hasGitmodules,
          lastSubmoduleSyncOk: sub.ok,
          lastSubmoduleSyncError: sub.error,
        })
        .where(eq(cachedRepos.id, row.id))
        .run()
      const updated = {
        ...row,
        lastFetchedAt: ts,
        hasSubmodules: sub.hasGitmodules,
        lastSubmoduleSyncOk: sub.ok,
        lastSubmoduleSyncError: sub.error,
      }
      return {
        cached: rowToCached(updated, await refTaskCount(deps.db, row.url)),
        cold: false,
        fetchOk,
        fetchError,
        submoduleSyncOk: sub.ok,
        submoduleSyncError: sub.error,
        hasSubmodules: sub.hasGitmodules,
        ffOutcomes,
      }
    }

    if (row) {
      // Cache row points at a missing / corrupt dir. Drop it and re-clone.
      log.warn('cached repo dir invalid; treating as cold clone', {
        url: redacted,
        localPath: row.localPath,
      })
      deps.db.delete(cachedRepos).where(eq(cachedRepos.id, row.id)).run()
    }

    // Cold path: clone into a sibling temp dir, then atomic rename.
    mkdirSync(cacheRoot, { recursive: true })
    const tmpDir = join(cacheRoot, `${hash}-${slug}.partial-${ulid()}`)
    // RFC-034: recurse into submodules during clone so the cache is usable
    // as-is. `--jobs N` is only emitted when N > 1 (matches gitSubmodule.ts
    // policy and stays compatible with git < 2.13 if effective jobs got
    // clamped to 1).
    const cloneArgs: string[] = ['clone']
    // Windows MAX_PATH=260: enable long path support in git
    if (process.platform === 'win32') {
      cloneArgs.push('-c', 'core.longPaths=true')
    }
    if (submodule.mode !== 'never') {
      cloneArgs.push('--recurse-submodules')
      if (submodule.jobs > 1) {
        cloneArgs.push('--jobs', String(submodule.jobs))
      }
    }
    cloneArgs.push(input.url, tmpDir)
    const r = await spawnGit(cloneArgs)
    if (r.exitCode !== 0) {
      // Wipe whatever git may have left behind.
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
      const stderr = redactGitUrl(r.stderr.trim())
      throw new DomainError(
        'repo-clone-failed',
        `git clone failed for ${redacted}: ${stderr}`,
        400,
        { url: redacted, stderr },
      )
    }
    // Probe default branch before moving into place — runs from tmpDir
    const defaultBr = await detectDefaultBranchInRepo(tmpDir)

    // Atomic rename onto the canonical cache path.
    try {
      // If a previous failed run left a stale dir, remove it first.
      if (existsSync(cacheDir)) {
        rmSync(cacheDir, { recursive: true, force: true })
      }
      await rename(tmpDir, cacheDir)
    } catch (err) {
      try {
        rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* best-effort */
      }
      throw new DomainError(
        'repo-clone-failed',
        `failed to finalize cache dir for ${redacted}: ${(err as Error).message}`,
        500,
        { url: redacted },
      )
    }

    // RFC-034: clone already recursed (or was disabled). Probe `.gitmodules`
    // so we record `has_submodules` accurately on this fresh row. We do NOT
    // re-run sync/update — that would be redundant.
    const hasGitmodules = submodule.mode === 'never' ? false : detectSubmodules(cacheDir)

    const ts = now()
    const id = ulid()
    deps.db
      .insert(cachedRepos)
      .values({
        id,
        urlHash: hash,
        url: input.url,
        localPath: cacheDir,
        defaultBranch: defaultBr,
        lastFetchedAt: ts,
        createdAt: ts,
        hasSubmodules: hasGitmodules,
        lastSubmoduleSyncOk: true,
        lastSubmoduleSyncError: null,
      })
      .run()
    log.info('cloned new cached repo', { url: redacted, hash, localPath: cacheDir })
    return {
      cached: rowToCached(
        {
          id,
          urlHash: hash,
          url: input.url,
          localPath: cacheDir,
          defaultBranch: defaultBr,
          lastFetchedAt: ts,
          createdAt: ts,
          hasSubmodules: hasGitmodules,
          lastSubmoduleSyncOk: true,
          lastSubmoduleSyncError: null,
        },
        await refTaskCount(deps.db, input.url),
      ),
      cold: true,
      fetchOk: true,
      fetchError: null,
      submoduleSyncOk: true,
      submoduleSyncError: null,
      hasSubmodules: hasGitmodules,
      ffOutcomes: [],
    }
  })

  return await withTimeout(work, timeoutMs, `resolveCachedRepo(${redacted})`)
}

async function refTaskCount(db: DbClient, url: string): Promise<number> {
  const r = db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(tasks)
    .where(eq(tasks.repoUrl, url))
    .all()
  return r[0]?.count ?? 0
}

export async function listCachedRepos(db: DbClient): Promise<CachedRepo[]> {
  const rows = db.select().from(cachedRepos).all()
  const out: CachedRepo[] = []
  for (const row of rows) {
    out.push(rowToCached(row, await refTaskCount(db, row.url)))
  }
  // Most recently fetched first.
  out.sort((a, b) =>
    a.lastFetchedAt > b.lastFetchedAt ? -1 : a.lastFetchedAt < b.lastFetchedAt ? 1 : 0,
  )
  return out
}

export interface RefreshCachedRepoResult {
  item: CachedRepo
  fetchOk: boolean
  fetchError: string | null
  /** RFC-034: outcome of the submodule pass triggered by this manual refresh. */
  submoduleSyncOk: boolean
  submoduleSyncError: string | null
  hasSubmodules: boolean
}

export async function refreshCachedRepo(
  deps: GitRepoCacheDeps,
  id: string,
): Promise<RefreshCachedRepoResult> {
  const rows = deps.db.select().from(cachedRepos).where(eq(cachedRepos.id, id)).limit(1).all()
  const row = rows[0]
  if (!row) {
    throw new NotFoundError('cached-repo-not-found', `cached repo ${id} not found`)
  }
  const now = deps.now ?? Date.now
  const redacted = redactGitUrl(row.url)
  const submodule = resolveSubmoduleParams(deps.submoduleMode, deps.submoduleJobs)

  return await withUrlLock(row.urlHash, async () => {
    if (!(await isValidGitDir(row.localPath))) {
      throw new DomainError(
        'repo-cache-corrupt',
        `cache dir missing for ${redacted}; delete and re-launch a task to re-clone`,
        409,
        { url: redacted, localPath: row.localPath },
      )
    }
    const r = await runGit(row.localPath, ['fetch', '--all', '--prune', '--tags'])
    const ts = now()
    let fetchOk = true
    let fetchError: string | null = null
    if (r.exitCode !== 0) {
      fetchOk = false
      fetchError = redactGitUrl(r.stderr.trim())
      log.warn('manual refresh fetch failed', { url: redacted, stderr: fetchError })
    }
    const sub = await syncSubmodules(row.localPath, {
      mode: submodule.mode,
      jobs: submodule.jobs,
    })
    if (!sub.ok) {
      log.warn('manual refresh submodule sync failed', {
        url: redacted,
        stderr: sub.error ?? '',
      })
    }
    deps.db
      .update(cachedRepos)
      .set({
        lastFetchedAt: ts,
        hasSubmodules: sub.hasGitmodules,
        lastSubmoduleSyncOk: sub.ok,
        lastSubmoduleSyncError: sub.error,
      })
      .where(eq(cachedRepos.id, id))
      .run()
    const updated = {
      ...row,
      lastFetchedAt: ts,
      hasSubmodules: sub.hasGitmodules,
      lastSubmoduleSyncOk: sub.ok,
      lastSubmoduleSyncError: sub.error,
    }
    return {
      item: rowToCached(updated, await refTaskCount(deps.db, row.url)),
      fetchOk,
      fetchError,
      submoduleSyncOk: sub.ok,
      submoduleSyncError: sub.error,
      hasSubmodules: sub.hasGitmodules,
    }
  })
}

export interface DeleteCachedRepoOptions {
  /** Skip the "referenced by N tasks" guard. Caller (HTTP route) flips this
   * after user confirmation. */
  force?: boolean
}

export class CachedRepoHasReferencesError extends DomainError {
  constructor(
    public readonly count: number,
    public readonly urlRedacted: string,
  ) {
    super(
      'cached-repo-has-references',
      `${count} task(s) still reference ${urlRedacted}; pass force=1 to delete anyway`,
      409,
      { count, urlRedacted },
    )
  }
}

export async function deleteCachedRepo(
  deps: GitRepoCacheDeps,
  id: string,
  options: DeleteCachedRepoOptions = {},
): Promise<{ deletedLocalPath: string }> {
  const rows = deps.db.select().from(cachedRepos).where(eq(cachedRepos.id, id)).limit(1).all()
  const row = rows[0]
  if (!row) {
    throw new NotFoundError('cached-repo-not-found', `cached repo ${id} not found`)
  }
  const count = await refTaskCount(deps.db, row.url)
  if (count > 0 && !options.force) {
    throw new CachedRepoHasReferencesError(count, redactGitUrl(row.url))
  }
  return await withUrlLock(row.urlHash, async () => {
    try {
      rmSync(row.localPath, { recursive: true, force: true })
    } catch (err) {
      log.warn('failed to rm cache dir; deleting DB row anyway', {
        url: redactGitUrl(row.url),
        err: (err as Error).message,
      })
    }
    deps.db.delete(cachedRepos).where(eq(cachedRepos.id, id)).run()
    return { deletedLocalPath: row.localPath }
  })
}

/**
 * Resolve the first 10 short branch + tag refs from a cached repo, useful for
 * "you asked for ref X but here are the available ones" 4xx bodies.
 */
export async function listAvailableRefs(repoPath: string, limit = 10): Promise<string[]> {
  const out: string[] = []
  const heads = await runGit(repoPath, [
    'for-each-ref',
    `--count=${limit}`,
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ])
  if (heads.exitCode === 0) {
    for (const line of heads.stdout.split('\n')) {
      const v = line.trim()
      if (v.length > 0) out.push(v)
      if (out.length >= limit) break
    }
  }
  return out
}
