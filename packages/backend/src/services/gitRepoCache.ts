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
  isFileSchemeUrl,
  gitUrlLegacyFileCacheKeyWith,
  parseGitUrl,
  redactGitUrl,
} from '@agent-workflow/shared'
import { and, eq, sql } from 'drizzle-orm'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ulid } from 'ulid'
import type { SecretBox } from '@/auth/secretBox'
import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { cachedRepos, scheduledTasks, taskRepos, tasks } from '@/db/schema'
import { ConflictError, DomainError, NotFoundError, ValidationError } from '@/util/errors'
import {
  classifyBaseRef,
  GIT_ABORTED_EXIT_CODE,
  GIT_TIMEOUT_EXIT_CODE,
  nonInteractiveGitEnv,
  runGit,
} from '@/util/git'
import { hardenGitArgs } from '@/util/gitHardening'
import { createLogger } from '@/util/log'
import { leaseGitCredential } from '@/services/gitCredential'
import { redactSensitiveString } from '@/util/redact'
import { Paths } from '@/util/paths'
import { getCachedGitCapabilities } from '@/services/gitVersion'
import { detectSubmodules, syncSubmodules, type SubmoduleMode } from '@/services/gitSubmodule'
// RFC-248 D13: 删仓的第二个拦截理由——被仓库组引用。
import { detachRepoFromAllGroups, groupsReferencingRepo } from '@/services/repoGroup'
// RFC-210 G9: config/index.ts only depends on shared + fs + errors + log, so this
// adds no cycle. util/git.ts still never imports config directly — it reaches
// resolveSubmoduleParams through the existing dynamic import.
import { loadConfig } from '@/config'
import { KeyedSerialQueue } from '@/util/keyedSerialQueue'
import { platformSpawnOptionsForHost } from '@/util/platformExec'
import {
  forgetVolatileRepoUrl,
  rememberVolatileRepoUrl,
  unsealRepoUrl,
} from '@/services/repoCredentials'
import { sha1Hex } from '@/util/hash'
import { raceWithFallback } from '@/util/process'

const log = createLogger('git-repo-cache')

const DEFAULT_CLONE_TIMEOUT_MS = 30 * 60 * 1000

const UNAVAILABLE_REPO_URL = '<url unavailable>'

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** Per-URL serialization. Same urlHash → second caller awaits the first. */
const urlQueue = new KeyedSerialQueue<string>()

function withUrlLock<T>(urlHash: string, fn: () => Promise<T>): Promise<T> {
  return urlQueue.run(urlHash, fn)
}

/**
 * 身份登记**专用**的短临界区——与 `withUrlLock` 分开是刻意的。
 *
 * `withUrlLock` 是**克隆锁**：持有它的临界区里跑 `git clone`/`fetch`，一次可能几分钟。
 * 身份登记只是一次「查有没有、没有就插一行」的纯 DB 写，若共用那把锁，同一 URL 上
 * 只要有人正在克隆，后来者的**请求路径**就会一直堵到克隆结束——G7 承诺的「启动接口
 * 立刻返回」对第二个用户直接失效（RFC-287 T14 二轮门实测：门禁里这条断言从 <1.5s
 * 变成 3005ms，正好等于前一次克隆的 timeout）。
 *
 * 两把锁不会互相踩：身份登记只写「行在不在」，克隆只写内容列（defaultBranch /
 * lastFetchedAt / hasSubmodules）与磁盘；且冷路径的领养走的是 `urlHash` 唯一约束
 * 已经存在的那一行，先插后领养与先领养后插的结果一致。
 */
const identityQueue = new KeyedSerialQueue<string>()
function withIdentityLock<T>(urlHash: string, fn: () => Promise<T>): Promise<T> {
  return identityQueue.run(urlHash, fn)
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
  opts?: { timeoutMs?: number; env?: Record<string, string>; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({
    ...platformSpawnOptionsForHost(),
    // RFC-252 G1: same hardening as runGit — this is the second (and only other)
    // production git spawn point, so the two must not drift.
    cmd: ['git', ...hardenGitArgs(args)],
    // Explicit env passthrough — see runGit() in util/git.ts for rationale.
    // nonInteractiveGitEnv() also stops ssh from hanging the daemon on first
    // connect to an unknown host (ssh reads /dev/tty, not stdin, for prompts).
    // RFC-205 G1: opts.env carries the askpass lease (paths only, no secrets).
    env: { ...nonInteractiveGitEnv(), ...(opts?.env ?? {}) },
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    // RFC-208: with a deadline, run in our own process group so the timer can
    // SIGKILL the whole tree. `git clone` delegates to ssh / credential helpers,
    // and killing only the direct child leaves those alive holding the pipes.
    ...(opts?.timeoutMs !== undefined || opts?.signal !== undefined ? { detached: true } : {}),
  })

  // 进程组 SIGKILL——timeoutMs 与 signal 共用同一条杀法（见上面 RFC-208 的理由）。
  const killTree = (): void => {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      proc.kill('SIGKILL')
    }
  }

  let aborted = false
  const onAbort = (): void => {
    aborted = true
    killTree()
  }
  if (opts?.signal !== undefined) {
    if (opts.signal.aborted) onAbort()
    else opts.signal.addEventListener('abort', onAbort, { once: true })
  }
  const detachAbort = (): void => {
    opts?.signal?.removeEventListener('abort', onAbort)
  }

  if (opts?.timeoutMs === undefined) {
    if (opts?.signal === undefined) {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { stdout, stderr, exitCode }
    }
    // 带 signal：与 timeout 分支同构——先等退出，再给管道读取一个上限（存活的
    // 孙进程可能继承写端，让 `.text()` 永远等不到 EOF）。
    try {
      const outP = new Response(proc.stdout).text().catch(() => '')
      const errP = new Response(proc.stderr).text().catch(() => '')
      const exitCode = await proc.exited
      const stdout = await raceWithFallback(outP, 250, '')
      const stderr = await raceWithFallback(errP, 250, '')
      if (!aborted) return { stdout, stderr, exitCode }
      // 取消必须可诊断，且绝不能被误判成成功——被 SIGKILL 的进程按平台可能报 0/null。
      return {
        stdout,
        stderr: `${stderr}\ngit aborted (canceled; killed)`.trim(),
        exitCode: exitCode === 0 ? GIT_ABORTED_EXIT_CODE : exitCode,
      }
    } finally {
      detachAbort()
    }
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree()
  }, opts.timeoutMs)
  try {
    const outP = new Response(proc.stdout).text().catch(() => '')
    const errP = new Response(proc.stderr).text().catch(() => '')
    const exitCode = await proc.exited
    const stdout = await raceWithFallback(outP, 250, '')
    const stderr = await raceWithFallback(errP, 250, '')
    if (!timedOut) return { stdout, stderr, exitCode }
    return {
      stdout,
      stderr: `${stderr}\ngit timed out after ${opts.timeoutMs}ms (killed)`.trim(),
      exitCode: exitCode === 0 ? GIT_TIMEOUT_EXIT_CODE : exitCode,
    }
  } finally {
    clearTimeout(timer)
    detachAbort()
  }
}

export interface GitRepoCacheDeps {
  db: DbClient
  /** Override app home (tests). Defaults to Paths.root. */
  appHome?: string
  /** Mutex + clone/fetch wait budget in ms. Default 30 min. */
  cloneTimeoutMs?: number
  /** RFC-303 protected Webhook pre-task launch owner. */
  signal?: AbortSignal
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
  /**
   * RFC-204 impl-gate P0-2 — seal the credentialed URL AT INSERT time on the
   * cold-clone path. When present, a fresh row stores `url_enc`; when omitted
   * (tests / custom embedding), the safe display URL is still persisted but no
   * recoverable plaintext is written to SQLite.
   */
  secretBox?: SecretBox
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
    // RFC-204: the original URL never leaves the daemon — cached_repos is a
    // shared pool behind `repos:read` (user baseline), so emitting it would hand
    // every logged-in user the credentials in other people's private repo URLs.
    urlRedacted: row.urlRedacted ?? UNAVAILABLE_REPO_URL,
    // Historical slugs can embed `?access_token=` (parseGitUrl keeps the query
    // in parsed.path), so the path needs redacting on the wire too.
    localPath: redactSensitiveString(row.localPath),
    defaultBranch: row.defaultBranch ?? null,
    lastFetchedAt: new Date(row.lastFetchedAt).toISOString(),
    lastAutoRefreshAt:
      row.lastAutoRefreshAt === null || row.lastAutoRefreshAt === undefined
        ? null
        : new Date(row.lastAutoRefreshAt).toISOString(),
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
/**
 * RFC-210 G9: read the submodule settings off disk.
 *
 * This is the wiring RFC-034 documented but never built. The reason it was
 * missing is structural: neither `scheduler.ts` nor `nodeIsolation.ts` imports
 * config at all, so nobody along the call chain was in a position to pass it —
 * every caller ended up handing `resolveSubmoduleParams` a pair of `undefined`s
 * and getting the hard-coded defaults back.
 *
 * `existsSync` FIRST: `loadConfig` writes a default config file when the path is
 * missing, and a git helper must not have that side effect. A malformed config
 * degrades to defaults rather than failing the git operation around it.
 */
function submoduleConfigFromDisk(): { mode?: SubmoduleMode; jobs?: number; remote?: boolean } {
  try {
    if (!existsSync(Paths.config)) return {}
    const cfg = loadConfig(Paths.config)
    const out: { mode?: SubmoduleMode; jobs?: number; remote?: boolean } = {}
    if (cfg.gitRecurseSubmodules !== undefined) out.mode = cfg.gitRecurseSubmodules
    if (cfg.gitSubmoduleJobs !== undefined) out.jobs = cfg.gitSubmoduleJobs
    if (cfg.gitSubmoduleRemote !== undefined) out.remote = cfg.gitSubmoduleRemote
    return out
  } catch {
    return {}
  }
}

export function resolveSubmoduleParams(
  inMode: SubmoduleMode | undefined,
  inJobs: number | undefined,
): { mode: SubmoduleMode; jobs: number; remote: boolean } {
  const caps = getCachedGitCapabilities()
  // Precedence: explicit argument > settings > built-in default. Both settings
  // are optional and absent from a default config.json, so an untouched install
  // resolves to exactly the pre-RFC-210 values.
  const fromDisk = submoduleConfigFromDisk()
  let mode: SubmoduleMode = inMode ?? fromDisk.mode ?? 'auto'
  if (caps && !caps.supportsRecurseInWorktree) {
    mode = 'never'
  }
  let jobs = Math.max(1, Math.min(32, Math.floor(inJobs ?? fromDisk.jobs ?? 4)))
  if (caps && !caps.supportsSubmoduleJobs) {
    jobs = 1
  }
  // RFC-210 G8: `--remote` pulls each submodule to its upstream branch tip
  // instead of the commit the superproject records. Off by default — it makes a
  // task's baseline drift with whatever upstream did, which costs reproducibility.
  return { mode, jobs, remote: fromDisk.remote ?? false }
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

/**
 * RFC-287 G7 / AC-11 —— **只登记仓库身份，不碰网络**。
 *
 * 为什么需要它：G7 把克隆挪到任务行落库之后（异步准备），于是「重试准备仓库」这条
 * AC-11 语义要求重试时还能找回**原始来源**。可任务行存不住来源——`tasks.repo_url`
 * 是**脱敏**存的，源码里那句注释写得很直白：「stored REDACTED so it can never drive
 * a relaunch; this id (cached_repo_id) is what does」。而 `cached_repo_id` 按老流程
 * 要等克隆成功才存在。结果就是：延后准备的任务在准备失败时，手里既没有可用的 URL
 * 也没有 id，重试无从谈起。
 *
 * 修法是把「解析身份」与「取回内容」拆开：身份（canonical hash → 一行 cached_repos，
 * URL 按既有规则密封）是**纯 DB 写**，几毫秒，留在请求路径里；克隆 / fetch / 建工作树
 * 才是慢的那部分，异步推进。这样占位任务行就能带上一个**真实且稳定**的
 * `cachedRepoId`，重试直接照它重建来源，既不必新增列，也不必把明文凭据多存一份。
 *
 * 该行以 `lastFetchedAt === 0` 标记「尚未取回内容」，这一个哨兵同时管三件事：
 *   · `resolveCachedRepo` 的冷路径据此**领养**而不是删除重建（保住 id）；
 *   · 后台自动保鲜不会选中它（selectDueRepos 要求 lastFetchedAt >= freshAfter）；
 *   · UI 上如实显示为「从未同步」。
 *
 * 幂等：同一 URL 重复调用返回同一行；与 `resolveCachedRepo` 共用同一把 per-URL 锁，
 * 因此不会与正在进行的克隆抢同一行。
 */
export async function ensureCachedRepoIdentity(
  deps: GitRepoCacheDeps,
  input: { url: string },
): Promise<{ cachedRepoId: string; urlRedacted: string }> {
  const parsed = parseGitUrl(input.url)
  if (!parsed) {
    throw new ValidationError('repo-url-invalid', 'unsupported or malformed Git URL', {
      url: redactGitUrl(input.url),
    })
  }
  const { hash, slug } = gitUrlCacheKeyWith(parsed, sha1Hex)
  const appHome = deps.appHome ?? Paths.root
  const cacheDir = join(appHome, 'repos', `${hash}-${slug}`)
  const redacted = redactGitUrl(input.url)
  return await withIdentityLock(hash, async () => {
    const existing = deps.db
      .select()
      .from(cachedRepos)
      .where(eq(cachedRepos.urlHash, hash))
      .limit(1)
      .all()[0]
    if (existing !== undefined) {
      return { cachedRepoId: existing.id, urlRedacted: existing.urlRedacted ?? redacted }
    }
    const id = ulid()
    const box = deps.secretBox
    deps.db
      .insert(cachedRepos)
      .values({
        id,
        urlHash: hash,
        urlEnc: box !== undefined ? box.seal(input.url) : null,
        urlRedacted: redacted,
        localPath: cacheDir,
        defaultBranch: null,
        // 哨兵：尚未取回内容。见上面的三重作用。
        lastFetchedAt: 0,
        createdAt: (deps.now ?? Date.now)(),
        hasSubmodules: null,
        lastSubmoduleSyncOk: null,
        lastSubmoduleSyncError: null,
      })
      .run()
    if (box === undefined) rememberVolatileRepoUrl(deps.db, id, input.url)
    log.info('registered cached repo identity (no clone yet)', { url: redacted, hash })
    return { cachedRepoId: id, urlRedacted: redacted }
  })
}

export async function resolveCachedRepo(
  deps: GitRepoCacheDeps,
  input: ResolveCachedRepoInput,
): Promise<ResolveCachedRepoResult> {
  if (signalAborted(deps.signal)) {
    throw new ConflictError('webhook-mr-launch-terminal', 'repository preparation was revoked')
  }
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
    let row = existing[0]

    // RFC-165 (F19-r4): file:// dual-read + verified lazy re-key. The pre-165
    // cache key folded case and the `.git` suffix, so file mirrors cached
    // before this ship live under a LOSSY legacy hash. On a new-key miss,
    // look the legacy key up — but because the fold is lossy, two different
    // new keys can collide onto one legacy key, so only adopt the row when
    // ITS OWN url re-canonicalizes to OUR new key; then re-key in place
    // (url_hash CAS under both locks; local_path/dir untouched — the hash is
    // just an index, no second clone).
    if (row === undefined && parsed.kind === 'file') {
      const legacy = gitUrlLegacyFileCacheKeyWith(parsed, sha1Hex)
      if (legacy !== null && legacy.hash !== hash) {
        row = await withUrlLock(legacy.hash, async () => {
          const candidates = deps.db
            .select()
            .from(cachedRepos)
            .where(eq(cachedRepos.urlHash, legacy.hash))
            .limit(1)
            .all()
          const cand = candidates[0]
          if (cand === undefined) return undefined
          const candPlain = unsealRepoUrl(cand, deps.secretBox, deps.db)
          const candParsed = candPlain === null ? null : parseGitUrl(candPlain)
          const candNewHash =
            candParsed !== null ? gitUrlCacheKeyWith(candParsed, sha1Hex).hash : null
          if (candNewHash !== hash) return undefined // lossy collision — NOT our repo
          deps.db
            .update(cachedRepos)
            .set({ urlHash: hash })
            .where(and(eq(cachedRepos.id, cand.id), eq(cachedRepos.urlHash, legacy.hash)))
            .run()
          log.info('re-keyed legacy file:// cache row', {
            url: redacted,
            from: legacy.hash,
            to: hash,
          })
          return { ...cand, urlHash: hash }
        })
      }
    }

    if (row && (await isValidGitDir(row.localPath))) {
      // Warm path.
      let fetchOk = true
      let fetchError: string | null = null
      if (fetchOnReuse) {
        // RFC-205 G1 — credentials never live in the mirror's .git/config:
        // idempotently normalise origin to the redacted URL (also the one-time
        // scrub for pre-RFC-205 mirrors), then feed the credential through a
        // one-shot askpass lease for THIS fetch only.
        await runGit(row.localPath, ['remote', 'set-url', 'origin', redacted], {
          signal: deps.signal,
        }).catch(() => null)
        // Impl-gate P0-6 (Codex 2026-07-22): runGit does NOT reject on a nonzero
        // git exit, so the `.catch()` above silently masked a FAILED set-url
        // (read-only / locked / corrupt config). We must not then fetch off an
        // origin that STILL holds a plaintext token. Verify the origin is
        // credential-free; if it can't be proven clean, refuse the mirror.
        const originNow = await runGit(row.localPath, ['remote', 'get-url', 'origin'], {
          signal: deps.signal,
        })
        const originUrl = originNow.stdout.trim()
        if (originNow.exitCode !== 0 || redactGitUrl(originUrl) !== originUrl) {
          throw new DomainError(
            'repo-origin-not-sanitized',
            `refusing to reuse the mirror for ${redacted}: stripping the credential from its ` +
              `origin failed (.git/config may be read-only, locked, or corrupt), so a plaintext ` +
              `token may remain in .git/config`,
            500,
            { url: redacted },
          )
        }
        const lease = leaseGitCredential(input.url)
        let r: Awaited<ReturnType<typeof runGit>>
        try {
          r = await runGit(
            row.localPath,
            [...(lease?.leadingArgs ?? []), 'fetch', '--all', '--prune', '--tags'],
            {
              timeoutMs,
              signal: deps.signal,
              ...(lease !== null ? { env: lease.env } : {}),
            },
          )
        } finally {
          lease?.cleanup()
        }
        if (r.exitCode !== 0) {
          fetchOk = false
          fetchError = redactGitUrl(r.stderr.trim())
          log.warn('git fetch on reuse failed', { url: redacted, stderr: fetchError })
          // RFC-165 (F19): a file:// source that can't be fetched means the
          // SOURCE DIRECTORY is gone/unreadable — running off the stale
          // mirror would silently diverge from the retired path-mode
          // semantics ("read the local repo's live state"). Hard fail; other
          // schemes keep the warning-and-stale-mirror behavior (network
          // blips are expected there).
          if (parsed.kind === 'file') {
            throw new DomainError(
              'repo-file-source-unreachable',
              `file:// source for ${redacted} is missing or unreadable: ${fetchError}`,
              400,
              { url: redacted, stderr: fetchError },
            )
          }
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
            // RFC-165 (F19): a requested branch that no longer resolves in a
            // file:// source (deleted in the source repo) must hard-fail —
            // silently keeping the stale local branch breaks the "read the
            // source's live state" fidelity contract.
            if (parsed.kind === 'file' && outcome.warning === 'origin-ref-missing') {
              // Keep the legacy repo-ref-not-found shape (availableRefs UX).
              const available = await listAvailableRefs(row.localPath, 10)
              throw new DomainError(
                'repo-ref-not-found',
                `ref '${candidate}' not found in ${redacted}`,
                400,
                { url: redacted, ref: candidate, availableRefs: available },
              )
            }
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
      // `lastFetchedAt` means the last SUCCESSFUL fetch. A failed warm reuse
      // may still refresh submodule diagnostics, but must not make stale code
      // look freshly synchronized in the repository UI.
      const ts = fetchOk ? now() : row.lastFetchedAt
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
        cached: rowToCached(updated, await refTaskCount(deps.db, row.id)),
        cold: false,
        fetchOk,
        fetchError,
        submoduleSyncOk: sub.ok,
        submoduleSyncError: sub.error,
        hasSubmodules: sub.hasGitmodules,
        ffOutcomes,
      }
    }

    // RFC-287 G7/AC-11：区分「**身份行**（只登记了身份、还没克隆过）」与「陈旧行
    // （曾经克隆成功、目录后来没了）」。两者在这里长得一样——都是 row 存在但
    // `isValidGitDir` 为假——但处置必须相反：
    //   · 陈旧行：删掉重建（保持原行为）。它的 id 已经被外界引用过，但那份引用指向
    //     的镜像内容已经不存在，换新 id 是诚实的。
    //   · 身份行：**必须保住 id**。它是「先把仓库身份落定、再异步克隆」这条路的
    //     全部意义所在——任务占位行存的就是这个 id，删了它，重试准备时就再也找不回
    //     来源，AC-11 直接失效。
    // 判据取 `lastFetchedAt === 0`：真正克隆成功过的行一定带真实时间戳，0 是
    // `ensureCachedRepoIdentity` 专门留下的哨兵（它同时让该行不会被后台保鲜选中——
    // selectDueRepos 要求 lastFetchedAt >= freshAfter）。
    // 二轮实现门 B-F4（用户拍板）：**目录失效的行一律原地领养、保住 id**，不再
    // 删行重建。
    //
    // 原先只领养 `lastFetchedAt === 0` 的身份行，陈旧行（曾克隆成功、目录后来没了）
    // 仍走删除重建。但 G7 之后 `tasks.cached_repo_id` 在**占位时**就写进任务行了，
    // 换 id 会让它变成悬空引用，AC-11 的「重试准备」再也找不回来源。
    //
    // 于是 `cached_repo_id` 成为**稳定身份**：只要 URL 不变，id 永不变。代价是
    // 「行存在」不再蕴含「镜像可用」——所有读者都得看 `lastFetchedAt` / `localPath`
    // （现有代码本来就在 `isValidGitDir` 检查，warm path 判假即落到这条冷路径）。
    // 领养时把行退回「身份态」：清掉上一次克隆留下的默认分支与子模块结论，并把
    // lastFetchedAt 归 0，免得一个内容已不存在的行还宣称自己在某时刻同步过。
    const adoptIdentityRowId = row?.id ?? null
    if (row !== undefined) {
      log.warn('cached repo dir invalid; re-cloning in place (identity preserved)', {
        url: redacted,
        localPath: row.localPath,
        cachedRepoId: row.id,
      })
      if (row.lastFetchedAt !== 0) {
        deps.db
          .update(cachedRepos)
          .set({ lastFetchedAt: 0, defaultBranch: null, hasSubmodules: null })
          .where(eq(cachedRepos.id, row.id))
          .run()
      }
    }

    // Cold path: clone into a sibling temp dir, then atomic rename.
    mkdirSync(cacheRoot, { recursive: true })
    const tmpDir = join(cacheRoot, `${hash}-${slug}.partial-${ulid()}`)
    // RFC-034: recurse into submodules during clone so the cache is usable
    // as-is. `--jobs N` is only emitted when N > 1 (matches gitSubmodule.ts
    // policy and stays compatible with git < 2.13 if effective jobs got
    // clamped to 1).
    const cloneArgs: string[] = ['clone']
    if (submodule.mode !== 'never') {
      cloneArgs.push('--recurse-submodules')
      if (submodule.jobs > 1) {
        cloneArgs.push('--jobs', String(submodule.jobs))
      }
    }
    // RFC-205 G1: clone with the REDACTED URL (argv shows in ps; the mirror's
    // origin is then born credential-free) and feed the secret via a one-shot
    // askpass lease instead.
    cloneArgs.push(redacted, tmpDir)
    const lease = leaseGitCredential(input.url)
    let r: Awaited<ReturnType<typeof spawnGit>>
    try {
      r = await spawnGit([...(lease?.leadingArgs ?? []), ...cloneArgs], {
        timeoutMs,
        signal: deps.signal,
        ...(lease !== null ? { env: lease.env } : {}),
      })
    } finally {
      lease?.cleanup()
    }
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
    // 领养身份行时**沿用它的 id**（见上面 adoptIdentityRowId 的长注释）：任务占位行
    // 存的就是这个 id，换掉等于把它变成悬空引用。
    const id = adoptIdentityRowId ?? ulid()
    // RFC-204/RFC-279: seal at INSERT when a key is available. Key-less test /
    // embedding shapes retain only the redacted display form, never plaintext.
    const box = deps.secretBox
    const urlEnc = box !== undefined ? box.seal(input.url) : null
    const rowValues = {
      urlHash: hash,
      urlEnc,
      // RFC-204: store the safe display form rather than deriving it per read.
      urlRedacted: redacted,
      localPath: cacheDir,
      defaultBranch: defaultBr,
      lastFetchedAt: ts,
      hasSubmodules: hasGitmodules,
      lastSubmoduleSyncOk: true,
      lastSubmoduleSyncError: null,
    }
    if (adoptIdentityRowId !== null) {
      // 就地补全：身份行此前只有 id/hash/url/localPath，克隆完才知道默认分支与
      // 子模块情况。`createdAt` 保持身份登记那一刻，不覆盖。
      deps.db.update(cachedRepos).set(rowValues).where(eq(cachedRepos.id, id)).run()
    } else {
      deps.db
        .insert(cachedRepos)
        .values({ id, createdAt: ts, ...rowValues })
        .run()
    }
    if (box === undefined) rememberVolatileRepoUrl(deps.db, id, input.url)
    log.info('cloned new cached repo', { url: redacted, hash, localPath: cacheDir })
    // RFC-165 (F19-r3): the COLD path must resolve requested refs to their
    // remote-tracking state too — the source may carry a non-default local
    // branch (unpushed work in a file:// repo) that a fresh clone only has as
    // origin/<branch>; without this FF the first launch's `rev-parse <branch>`
    // fails. Mirrors the warm-path RFC-068 loop (syncBranchToRemote CREATES
    // the missing local ref); file:// sources hard-fail on a missing ref.
    const coldFfOutcomes: FastForwardOutcome[] = []
    {
      const seen = new Set<string>()
      for (const candidate of deps.syncBranches ?? []) {
        if (seen.has(candidate)) continue
        seen.add(candidate)
        const kind = await classifyBaseRef(cacheDir, candidate)
        if (kind !== 'branch' && kind !== 'unknown') continue
        const outcome = await syncBranchToRemote(cacheDir, candidate)
        coldFfOutcomes.push(outcome)
        if (outcome.warning !== null) {
          log.warn('rfc068/cold-ff-failed', {
            url: redacted,
            branch: candidate,
            warning: outcome.warning,
          })
          if (parsed.kind === 'file' && outcome.warning === 'origin-ref-missing') {
            // Keep the legacy repo-ref-not-found shape (availableRefs UX) —
            // the pre-165 flow surfaced this from createWorktree's failed
            // rev-parse; we now catch it one step earlier, same contract.
            const available = await listAvailableRefs(cacheDir, 10)
            throw new DomainError(
              'repo-ref-not-found',
              `ref '${candidate}' not found in ${redacted}`,
              400,
              { url: redacted, ref: candidate, availableRefs: available },
            )
          }
        }
      }
    }
    return {
      cached: rowToCached(
        {
          id,
          urlHash: hash,
          urlEnc,
          urlRedacted: redacted,
          localPath: cacheDir,
          defaultBranch: defaultBr,
          lastFetchedAt: ts,
          createdAt: ts,
          hasSubmodules: hasGitmodules,
          lastSubmoduleSyncOk: true,
          lastSubmoduleSyncError: null,
          // RFC-210: a repo that was just cold-cloned has never been touched by
          // the background refresh loop, which is exactly what NULL means here.
          lastAutoRefreshAt: null,
        },
        await refTaskCount(deps.db, id),
      ),
      cold: true,
      fetchOk: true,
      fetchError: null,
      submoduleSyncOk: true,
      submoduleSyncError: null,
      hasSubmodules: hasGitmodules,
      ffOutcomes: coldFfOutcomes,
    }
  })

  const result = await withTimeout(work, timeoutMs, `resolveCachedRepo(${redacted})`)
  if (signalAborted(deps.signal)) {
    throw new ConflictError('webhook-mr-launch-terminal', 'repository preparation was revoked')
  }
  return result
}

/**
 * RFC-204: count references BY MIRROR ID, not by URL.
 *
 * The old `tasks.repo_url == url` join cannot survive sealing — the plaintext
 * column is blanked, so it would silently count everything against ''. It was
 * already wrong for private repos anyway, since repo_url is stored redacted
 * (RFC-054 W3-4) and never equalled the plaintext cache URL.
 *
 * Scheduled tasks are included: their launch payload references the mirror by
 * `cachedRepoId`, so deleting the row out from under an enabled schedule would
 * make its next fire die with `cached-repo-not-found`.
 */
async function refTaskCount(db: DbClient, cachedRepoId: string): Promise<number> {
  const r = db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(taskRepos)
    .where(eq(taskRepos.cachedRepoId, cachedRepoId))
    .all()
  let count = r[0]?.count ?? 0
  // RFC-287 G7：`task_repos` 在**仓库准备完成之前是空的**（回填与路径回写同事务，
  // 见 task.ts 的延后准备段），而 `tasks.cached_repo_id` 早在占位时就已指向
  // `ensureCachedRepoIdentity` 落定的身份行。只数 task_repos 会让这道引用守卫在
  // 整个准备窗口内**完全失明**——实测：不带 force 就能把一个正在被克隆/使用的镜像
  // 连行带目录删掉，任务的 cached_repo_id 随即悬空。
  //
  // 这道守卫存在的理由（上面注释原话）正是「deleting the row out from under …
  // a referencing task」，所以把 tasks 这一面补上。`distinct` 不必要：一个任务在
  // tasks 上只有一个 cached_repo_id，与 task_repos 的多行不重叠计数即可。
  const fromTasks = db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(tasks)
    .where(eq(tasks.cachedRepoId, cachedRepoId))
    .all()
  count += fromTasks[0]?.count ?? 0
  const needle = JSON.stringify(cachedRepoId)
  for (const row of db.select().from(scheduledTasks).all()) {
    if (row.launchPayload.includes(`"cachedRepoId":${needle}`)) count++
  }
  return count
}

/**
 * RFC-190: cardinality-only count for /api/overview. listCachedRepos runs a
 * per-repo referencing-task count (1+N queries) + full DTO assembly that a
 * plain "how many repos" question does not need; the overview oracle test
 * locks `countCachedRepos == listCachedRepos().length`.
 */
export async function countCachedRepos(db: DbClient): Promise<number> {
  const r = db
    .select({ count: sql<number>`count(*)`.as('count') })
    .from(cachedRepos)
    .all()
  return r[0]?.count ?? 0
}

export async function listCachedRepos(db: DbClient): Promise<CachedRepo[]> {
  const rows = db.select().from(cachedRepos).all()
  const out: CachedRepo[] = []
  for (const row of rows) {
    out.push(rowToCached(row, await refTaskCount(db, row.id)))
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

/**
 * Fetch + submodule-sync a single cached mirror.
 *
 * `opts.touchRecency` (default `true`) controls whether a successful fetch
 * advances `last_fetched_at`. Manual refresh and the task-launch warm fetch
 * ARE user activity, so they leave it `true`. The background auto-refresh loop
 * (RFC-210 G7) passes `false`: it must advance the mirror's objects without
 * counting as "someone used this repo", otherwise the recency window in
 * `selectDueRepos` — which reads `last_fetched_at` — would renew itself every
 * tick and an abandoned mirror would generate network traffic forever. The
 * loop records its own cadence in `last_auto_refresh_at` instead.
 */
export async function refreshCachedRepo(
  deps: GitRepoCacheDeps,
  id: string,
  opts?: { touchRecency?: boolean },
): Promise<RefreshCachedRepoResult> {
  const rows = deps.db.select().from(cachedRepos).where(eq(cachedRepos.id, id)).limit(1).all()
  const row = rows[0]
  if (!row) {
    throw new NotFoundError('cached-repo-not-found', `cached repo ${id} not found`)
  }
  const now = deps.now ?? Date.now
  const redacted = row.urlRedacted ?? UNAVAILABLE_REPO_URL
  const submodule = resolveSubmoduleParams(deps.submoduleMode, deps.submoduleJobs)
  // RFC-287 G5（design §10.7）——刷新是启动之外的**第二条**运行面，同拒 `file://`。
  //
  // 只拒启动不拒刷新的话，存量本机镜像照样被 `POST /api/cached-repos/:id/refresh`
  // 无限期保鲜（后台自动保鲜那条已在 submoduleRefresh.selectDueRepos 挡住，但手动
  // 刷新走的是这里）。
  //
  // 判据用 `url_redacted` 而非解封：脱敏只吃 `user:pass@`、**scheme 原样保留**，
  // 所以它够用且不必碰密钥（也就没有解封失败分支要处理）。
  //
  // NULL 同样拒（不知道 scheme 就不该主动去 fetch，与 selectDueRepos 的 fail-closed
  // 口径一致），但**错误码必须分开**：三轮门（Codex 契约面）P3 —— 存量 HTTPS 行因
  // 密钥轮换而只剩 `url_enc`、`url_redacted` 为 NULL 时，原来会回一句「file:// 镜像
  // 已不受支持」。fail-closed 本身没错，把「scheme 不可知 / 凭据不可用」谎报成 file
  // 却会把用户引向完全错误的修复方向（去推仓库到远端，而真正该做的是恢复密钥）。
  if (row.urlRedacted === null) {
    throw new DomainError(
      'repo-url-unavailable',
      `refusing to refresh cached repo '${row.id}': its URL is unreadable (sealed with a different secret.key?), so the remote cannot be verified`,
      409,
      { url: redacted },
    )
  }
  if (isFileSchemeUrl(row.urlRedacted)) {
    throw new DomainError(
      'repo-url-file-scheme-unsupported',
      `refusing to refresh ${redacted}: file:// mirrors are no longer a supported remote`,
      400,
      { url: redacted },
    )
  }

  return await withUrlLock(row.urlHash, async () => {
    if (!(await isValidGitDir(row.localPath))) {
      throw new DomainError(
        'repo-cache-corrupt',
        `cache dir missing for ${redacted}; delete and re-launch a task to re-clone`,
        409,
        { url: redacted, localPath: row.localPath },
      )
    }
    // RFC-208: manual refresh had NO budget at all — `withTimeout` (a bare
    // Promise.race) was never applied here, and even where it is applied it only
    // rejects the caller: the git child keeps running and the per-URL queue
    // stays held. Bounding the child itself is what actually frees both.
    const r = await runGit(row.localPath, ['fetch', '--all', '--prune', '--tags'], {
      timeoutMs: deps.cloneTimeoutMs ?? DEFAULT_CLONE_TIMEOUT_MS,
    })
    const ts = now()
    let fetchOk = true
    let fetchError: string | null = null
    if (r.exitCode !== 0) {
      fetchOk = false
      fetchError = redactGitUrl(r.stderr.trim())
      log.warn('manual refresh fetch failed', { url: redacted, stderr: fetchError })
      throw new DomainError(
        'repo-refresh-failed',
        `repository refresh failed for ${redacted}: ${fetchError || 'git fetch failed'}`,
        502,
        { url: redacted, stderr: fetchError },
      )
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
    // RFC-210 G7: auto-refresh advances the mirror's objects but must NOT renew
    // the recency window (see this function's doc + selectDueRepos). Everything
    // except last_fetched_at still reflects the fresh fetch either way.
    const touchRecency = opts?.touchRecency ?? true
    deps.db
      .update(cachedRepos)
      .set({
        ...(touchRecency ? { lastFetchedAt: ts } : {}),
        hasSubmodules: sub.hasGitmodules,
        lastSubmoduleSyncOk: sub.ok,
        lastSubmoduleSyncError: sub.error,
      })
      .where(eq(cachedRepos.id, id))
      .run()
    const updated = {
      ...row,
      lastFetchedAt: touchRecency ? ts : row.lastFetchedAt,
      hasSubmodules: sub.hasGitmodules,
      lastSubmoduleSyncOk: sub.ok,
      lastSubmoduleSyncError: sub.error,
    }
    return {
      item: rowToCached(updated, await refTaskCount(deps.db, row.id)),
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
    /**
     * RFC-248 D13 —— 引用这个镜像的仓库组。与「被 N 个任务引用」并列成为删除
     * 拦截的第二个理由：组是**用户手工编排**的定义，静默让它少一个仓，用户下次
     * 启动才发现，而那时已经想不起是哪次删除导致的。
     */
    public readonly referencingGroups: ReadonlyArray<{ id: string; name: string }> = [],
  ) {
    super(
      'cached-repo-has-references',
      `${[
        count > 0 ? `${count} task(s)` : null,
        referencingGroups.length > 0 ? `${referencingGroups.length} repo group(s)` : null,
      ]
        .filter((x) => x !== null)
        .join(' and ')} still reference ${urlRedacted}; pass force=1 to delete anyway`,
      409,
      { count, urlRedacted, referencingGroups },
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
  const count = await refTaskCount(deps.db, row.id)
  // RFC-248 D13: 任务引用与仓库组引用是两个独立的拦截理由，一起报给用户，
  // 免得他解决了一个再撞另一个。
  const groups = groupsReferencingRepo(deps.db, row.id)
  if ((count > 0 || groups.length > 0) && !options.force) {
    throw new CachedRepoHasReferencesError(count, row.urlRedacted ?? UNAVAILABLE_REPO_URL, groups)
  }
  return await withUrlLock(row.urlHash, async () => {
    try {
      // RFC-208: async removal. `rmSync` on a large mirror blocks Bun's single
      // event loop for the whole walk — which also means any timeout racing it
      // can never fire, since the timer callback cannot be serviced. Every other
      // request to the daemon stalls for the duration. `rm` yields between
      // entries, so the loop keeps serving and a deadline stays meaningful.
      await rm(row.localPath, { recursive: true, force: true })
    } catch (err) {
      log.warn('failed to rm cache dir; deleting DB row anyway', {
        url: row.urlRedacted ?? UNAVAILABLE_REPO_URL,
        err: (err as Error).message,
      })
    }
    // RFC-248 设计门二轮 H2 —— detach 必须在**锁内**、与删行在**同一事务**里。
    // 原实现把 detach 放在 withUrlLock 之前：等锁期间可以新建引用（那条引用随后
    // 指向一个已被删掉的镜像），而中途崩溃则留下「组已改、cached_repos 还在」的
    // 断链状态。
    //
    // 这段刻意**内联**而不是抽成闭包放在 try 之前：RFC-208 的守卫
    // （tests/rfc208-boot-and-external-timeouts.test.ts:135）用
    // `withUrlLock(row.urlHash, async () => {\n    try {` 做源码切片锚点来证明
    // 缓存目录删除走的是异步 `rm`。在箭头与 `try` 之间插任何东西都会切空那段、
    // 把守卫弄哑——那条守卫本身是对的，不该为我的排版让路。
    dbTxSync(deps.db, (tx) => {
      // 锁内**重查**引用：等锁期间可能有人刚把这个仓加进一个组。用启动时的快照
      // 去 detach 会漏掉新引用，随后删行被 FK 拒绝（或更糟——留下指向已消失
      // localPath 的成员行）。
      if (groupsReferencingRepo(deps.db, row.id).length > 0) {
        detachRepoFromAllGroups(deps.db, row.id)
      }
      tx.delete(cachedRepos).where(eq(cachedRepos.id, id)).run()
    })
    forgetVolatileRepoUrl(deps.db, id)
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
