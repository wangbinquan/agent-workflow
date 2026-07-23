// RFC-034: idempotent helper that syncs + initializes git submodules on a
// given working directory. Called from gitRepoCache cold/warm paths and from
// createWorktree right after `git worktree add`.
//
// Contract: never throws — failures are surfaced via `ok: false` so callers
// can decide whether to fail-loud (cold clone) or fail-quiet (warm fetch /
// worktree init, which only emit warnings).

import { redactGitUrl } from '@agent-workflow/shared'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AW_INTERNAL_GIT_IDENTITY, runGit, snapshotFullState } from '@/util/git'

export type SubmoduleMode = 'auto' | 'always' | 'never'

export interface SubmoduleSyncOptions {
  mode: SubmoduleMode
  jobs: number
  /**
   * RFC-210 G1: pass `--reference <poolDir>` so a FIRST-TIME init clones with a
   * shared object pool instead of a full copy.
   *
   * NOT a correctness mechanism, for two independent reasons:
   *  - On an ALREADY initialized module dir its effect is VERSION-DEPENDENT:
   *    git 2.50.1 leaves alternates absent (silent no-op), CI runners' git
   *    attaches it. Both exit 0, so a caller cannot tell which happened.
   *  - git applies a single `--reference` to EVERY submodule in the tree
   *    (measured: an unrelated submodule gets bound to this pool).
   * Correctness comes from `ensureSubmoduleAlternates`, which writes
   * `objects/info/alternates` per submodule. This flag is a first-clone
   * speedup only.
   */
  referencePool?: string
  /** RFC-210 G8: `--remote` (track the submodule's upstream branch tip). */
  remote?: boolean
  /** Override the redaction step (default: shared `redactGitUrl`). */
  redactStderr?: (s: string) => string
  /** Test hook: replace runGit. */
  runGitImpl?: typeof runGit
}

export interface SubmoduleSyncResult {
  ok: boolean
  /** Already-redacted; safe to log / persist / send to clients. */
  error: string | null
  hasGitmodules: boolean
}

/** Probe-only: does the working tree have a `.gitmodules` at its root? */
export function detectSubmodules(repoPath: string): boolean {
  try {
    return existsSync(join(repoPath, '.gitmodules'))
  } catch {
    return false
  }
}

function defaultRedact(s: string): string {
  return redactGitUrl(s.trim())
}

/**
 * Run `git submodule sync --recursive && git submodule update --init
 * --recursive --jobs N` on `repoPath`. Idempotent — repeated calls on a
 * fully-initialized tree are cheap no-ops.
 *
 * - `mode='never'`: short-circuit with ok=true, hasGitmodules=false, no git
 *   processes spawned. Used as the platform escape hatch.
 * - `mode='auto'`: skip when `.gitmodules` is absent; otherwise run.
 * - `mode='always'`: always run (idempotent no-op when `.gitmodules` absent).
 */
export async function syncSubmodules(
  repoPath: string,
  opts: SubmoduleSyncOptions,
): Promise<SubmoduleSyncResult> {
  const redact = opts.redactStderr ?? defaultRedact
  const run = opts.runGitImpl ?? runGit

  if (opts.mode === 'never') {
    return { ok: true, error: null, hasGitmodules: false }
  }

  const hasGitmodules = detectSubmodules(repoPath)
  if (opts.mode === 'auto' && !hasGitmodules) {
    return { ok: true, error: null, hasGitmodules: false }
  }

  // `submodule sync` is cheap and idempotent — pulls any URL changes from
  // .gitmodules into .git/config. Failure here is fatal for this pass.
  const sync = await run(repoPath, ['submodule', 'sync', '--recursive'])
  if (sync.exitCode !== 0) {
    return {
      ok: false,
      error: redact(sync.stderr) || 'submodule sync failed (no stderr)',
      hasGitmodules,
    }
  }

  const updateArgs = ['submodule', 'update', '--init', '--recursive']
  // RFC-210: both flags are opt-in and appended BEFORE --jobs so that a caller
  // passing neither produces the pre-RFC-210 argv byte-for-byte (AC-10/AC-12).
  if (opts.remote === true) {
    updateArgs.push('--remote')
  }
  if (opts.referencePool !== undefined) {
    updateArgs.push('--reference', opts.referencePool)
  }
  // jobs=1 is the default; only emit --jobs when > 1 so we play nice with
  // ancient git versions and keep argv small in logs.
  if (opts.jobs > 1) {
    updateArgs.push('--jobs', String(opts.jobs))
  }
  const update = await run(repoPath, updateArgs)
  if (update.exitCode !== 0) {
    return {
      ok: false,
      error: redact(update.stderr) || 'submodule update failed (no stderr)',
      hasGitmodules,
    }
  }

  return { ok: true, error: null, hasGitmodules }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-210: submodule topology, shared object pool, and per-submodule snapshots.
//
// Why this lives here: `util/git.ts` may not statically import this module (it
// reaches back via dynamic import to avoid a cycle), so every submodule-aware
// primitive that needs more than raw argv belongs on this side of the edge.
// ─────────────────────────────────────────────────────────────────────────────

/** One submodule as reported by `git submodule status --recursive`. */
export interface SubmoduleEntry {
  /**
   * Path relative to the superproject root, nested levels joined with '/'
   * (e.g. 'vendor/inner'). MAY CONTAIN SPACES — never interpolate it into a
   * git refname (see `subSlug`).
   */
  path: string
  /**
   * The submodule's WORKING-TREE HEAD — NOT the gitlink recorded in the
   * superproject index. The two diverge the moment a node commits inside the
   * submodule, which is precisely RFC-210's main scenario.
   */
  headSha: string
  /** ' ' in sync · '+' differs from index · '-' not initialized · 'U' conflicted. */
  flag: ' ' | '+' | '-' | 'U'
  /**
   * Number of '/'-separated segments. ONLY meaningful for bottom-up ordering
   * (a containing path is always strictly shorter than what it contains).
   * NOT a nesting level: 'vendor/libs/foo' can be a first-level submodule.
   */
  pathDepth: number
}

const STATUS_LINE_RE = /^(.)([0-9a-f]{40,64}) (.*)$/

/**
 * Strip the trailing ' (describe)' that `submodule status` appends for
 * initialized submodules. Paths may contain spaces and even parentheses, so we
 * only strip when the line actually ends with ')'.
 */
function stripDescribe(rest: string): string {
  if (!rest.endsWith(')')) return rest
  const cut = rest.lastIndexOf(' (')
  return cut === -1 ? rest : rest.slice(0, cut)
}

/**
 * Recursively list submodules of a working tree.
 *
 * Contract:
 *  - NOT-INITIALIZED submodules (flag '-') are not descended into by git, so
 *    their own nested submodules are invisible here.
 *  - Callers must gate on `detectSubmodules` first (AC-12: a repo without
 *    `.gitmodules` must not spawn any submodule process).
 * Never throws; a non-zero exit or empty output yields [].
 */
export async function listSubmodules(
  worktreePath: string,
  opts?: { runGitImpl?: typeof runGit },
): Promise<SubmoduleEntry[]> {
  const run = opts?.runGitImpl ?? runGit
  const r = await run(worktreePath, ['submodule', 'status', '--recursive'])
  if (r.exitCode !== 0) return []
  const out: SubmoduleEntry[] = []
  for (const line of r.stdout.split('\n')) {
    if (line.trim() === '') continue
    const m = STATUS_LINE_RE.exec(line)
    if (m === null) continue
    const [, rawFlag, rawSha, rawRest] = m
    if (rawFlag === undefined || rawSha === undefined || rawRest === undefined) continue
    const path = stripDescribe(rawRest)
    if (path === '') continue
    out.push({
      path,
      headSha: rawSha,
      flag: rawFlag as SubmoduleEntry['flag'],
      pathDepth: path.split('/').length,
    })
  }
  return out
}

/** Submodules that are actually usable — '-' (uninitialized) has no working dir. */
export function usableSubmodules(entries: SubmoduleEntry[]): SubmoduleEntry[] {
  return entries.filter((e) => e.flag !== '-')
}

/**
 * RFC-210 impl-gate A-fix — `listSubmodules` PLUS submodules that are declared
 * in `.gitmodules` and attached (have a `.git`) but are NOT in the index yet.
 *
 * `git submodule status` iterates INDEX gitlinks, so a submodule the platform
 * materialized as an UNSTAGED delta (a node ran `git submodule add`; the
 * accumulated task state carries it as `?? newsub/` until commit-push) is
 * invisible to it — measured: `status --recursive` prints nothing for an
 * attached submodule with no index entry. Every consumer that must see the
 * task's REAL topology (topology capture, head publish, recursive commit&push)
 * goes through this union; a declared-but-unattached path stays invisible, the
 * same as before.
 */
export async function listEffectiveSubmodules(
  worktreePath: string,
  opts?: { runGitImpl?: typeof runGit },
): Promise<SubmoduleEntry[]> {
  const out = await listSubmodules(worktreePath, opts)
  const seen = new Set(out.map((e) => e.path))
  const run = opts?.runGitImpl ?? runGit
  // `.gitmodules` is AGENT-AUTHORED content (that is the whole point of this
  // lister), so its declared paths are untrusted: `path = .` would recurse
  // forever, `path = ..`/absolute/symlinked paths would walk git operations
  // OUT of the task worktree. Containment-check every path via realpath and
  // never visit the same directory twice (Codex review round 2, P1).
  const realOf = (d: string): string | null => {
    try {
      return realpathSync(d)
    } catch {
      return null
    }
  }
  const visited = new Set<string>()

  const walk = async (levelPath: string, prefix: string): Promise<void> => {
    if (!existsSync(join(levelPath, '.gitmodules'))) return
    const levelReal = realOf(levelPath)
    if (levelReal === null || visited.has(levelReal)) return
    visited.add(levelReal)
    const declared = await run(levelPath, [
      'config',
      '-f',
      '.gitmodules',
      '--get-regexp',
      String.raw`^submodule\..*\.path$`,
    ])
    if (declared.exitCode !== 0) return
    for (const line of declared.stdout.split('\n')) {
      if (line.trim() === '') continue
      // `submodule.<name>.path <value>` — the value may contain spaces.
      const sp = line.indexOf(' ')
      if (sp < 0) continue
      const p = line.slice(sp + 1).trim()
      if (p === '') continue
      const abs = join(levelPath, p)
      // Strict containment: the resolved path must live INSIDE this level
      // (rejects '.', '..', absolute paths and symlinks that point out).
      const absReal = realOf(abs)
      if (absReal === null || !absReal.startsWith(levelReal + '/')) continue
      if (!existsSync(join(abs, '.git'))) continue
      const rel = prefix === '' ? p : `${prefix}/${p}`
      if (!seen.has(rel)) {
        const head = await run(abs, ['rev-parse', 'HEAD'])
        if (head.exitCode === 0 && head.stdout.trim() !== '') {
          seen.add(rel)
          out.push({
            path: rel,
            headSha: head.stdout.trim(),
            flag: ' ',
            pathDepth: rel.split('/').length,
          })
        }
      }
      // Recurse regardless of who listed this level: an INDEXED outer submodule
      // can still contain an unstaged-new inner one, and vice versa.
      await walk(abs, rel)
    }
  }
  await walk(worktreePath, '')
  return out
}

/** Bottom-up order: deepest paths first, so a child's gitlink bump is visible to its parent. */
export function bottomUp(entries: SubmoduleEntry[]): SubmoduleEntry[] {
  return [...entries].sort((a, b) => b.pathDepth - a.pathDepth || b.path.localeCompare(a.path))
}

/**
 * Ref-name-safe token for a submodule path.
 *
 * A submodule path MUST NOT be interpolated into a refname directly:
 *  - nested paths collide as directory/file — `refs/x/vendor` and
 *    `refs/x/vendor/inner` cannot coexist (measured: exit 128, "'refs/x/vendor'
 *    exists; cannot create '.../vendor/inner'"), and ANY >=2-level nesting hits it;
 *  - spaces are rejected outright ("refusing to update ref with bad name"), as
 *    are '.lock' suffixes, leading dots, and ~ ^ : ? * [ \.
 * The path itself is persisted in `iso_submodules_json`; the ref is only an anchor.
 */
export function subSlug(subPath: string): string {
  return createHash('sha1').update(subPath).digest('hex').slice(0, 16)
}

/** Node-scoped anchor: lives and dies with one node's iso worktree. */
export function poolRefName(taskId: string, nodeRunId: string, subPath: string): string {
  return `refs/agent-workflow/pool/${taskId}/${nodeRunId}/${subSlug(subPath)}`
}

/**
 * Worktree-scoped anchor: keeps the commit a canonical worktree's gitlink points
 * at reachable for as long as that worktree exists.
 *
 * Deliberately NOT keyed on task terminality: `worktreeAutoGc` defaults to false,
 * task worktrees are long-lived, and a merge result is a `commit-tree` object
 * reachable from no branch. Dropping this ref at task-terminal would leave the
 * user's canonical submodule pointing at an object the next pool gc deletes.
 */
export function worktreeRefName(taskId: string, subPath: string): string {
  return `refs/agent-workflow/wt/${taskId}/${subSlug(subPath)}`
}

/** Absolute git dir of a submodule inside a working tree, or null. */
export async function submoduleGitDir(
  worktreePath: string,
  subPath: string,
): Promise<string | null> {
  const r = await runGit(join(worktreePath, subPath), ['rev-parse', '--absolute-git-dir'])
  if (r.exitCode !== 0) return null
  const v = r.stdout.trim()
  return v === '' ? null : v
}

/**
 * Locate the shared object pool for one submodule of a working tree.
 *
 * The pool is the submodule's module dir inside the HOST repository (the thing
 * `--git-common-dir` points at), which every linked worktree of that repo shares.
 * Resolved by asking git in the host repo rather than hand-assembling
 * `modules/x/modules/y`, so nested layout assumptions can't drift.
 *
 * Returns null — caller must degrade to a worktree-private module dir — when:
 *  - the path isn't a git working tree (mock harnesses), or
 *  - `isPathMode` is set (D11): the host is the USER'S OWN repo, and a pool there
 *    would collect platform objects, refs and commits that can never be cleaned up.
 */
export async function resolveSubmodulePool(
  worktreePath: string,
  subPath: string,
  opts?: { isPathMode?: boolean },
): Promise<string | null> {
  if (opts?.isPathMode === true) return null
  const common = await runGit(worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (common.exitCode !== 0) return null
  const hostGitDir = common.stdout.trim()
  if (hostGitDir === '') return null
  // Ask git where THIS submodule's module dir lives, from the host repo's own
  // checkout, instead of assuming the modules/<a>/modules/<b> layout.
  const hostWorktree = dirname(hostGitDir)
  const viaHost = await submoduleGitDir(hostWorktree, subPath)
  if (viaHost !== null && existsSync(viaHost)) return viaHost
  // Host has no checkout of it (bare mirror): fall back to the documented layout.
  const guess = join(
    hostGitDir,
    'modules',
    ...subPath.split('/').flatMap((s, i) => (i === 0 ? [s] : ['modules', s])),
  )
  return existsSync(guess) ? guess : null
}

/**
 * RFC-210 impl-gate A3-fix — resolve a submodule's pool, CREATING it when the
 * path is new to the host.
 *
 * A submodule the node itself `git submodule add`ed has no pool to resolve:
 * its module dir lands in the ISO WORKTREE'S private admin dir
 * (`<host>/.git/worktrees/<iso>/modules/<path>` — measured; `modules/` is
 * per-worktree for a first-time add), which `git worktree remove --force`
 * deletes wholesale. Without a durable pool the node's commits inside the new
 * submodule cease to exist the moment the iso is discarded, while the parent
 * snapshot still records their gitlink — exactly the dangling-object class
 * RFC-210 exists to prevent. So for a new path the pool is created at the
 * host's canonical layout (`<hostGitDir>/modules/...`, bare — it only ever
 * stores objects and refs) before the first publish.
 *
 * Returns null when the host cannot be resolved at all (mock harness) or the
 * pool cannot be created.
 */
export async function ensureSubmodulePool(
  worktreePath: string,
  subPath: string,
): Promise<string | null> {
  const existing = await resolveSubmodulePool(worktreePath, subPath)
  if (existing !== null) return existing
  const common = await runGit(worktreePath, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ])
  if (common.exitCode !== 0) return null
  const hostGitDir = common.stdout.trim()
  if (hostGitDir === '') return null
  const pool = join(
    hostGitDir,
    'modules',
    ...subPath.split('/').flatMap((s, i) => (i === 0 ? [s] : ['modules', s])),
  )
  const init = await runGit(hostGitDir, ['init', '-q', '--bare', pool])
  if (init.exitCode !== 0) return null
  return pool
}

/**
 * RFC-210 — the paths DECLARED in a level's `.gitmodules`, distinguishing a
 * clean "no declarations" from a read/parse failure (Codex review round 9, P1).
 *
 * `ok: false` ⟹ `.gitmodules` EXISTS but git could not parse it (measured:
 * `git config --get-regexp` exits 128 on a malformed file, vs 1 for a valid
 * empty one). A caller must NOT then treat an absent path as "stray" — that
 * would misclassify a managed submodule and silently skip its update; it is an
 * error condition to surface. No `.gitmodules` at all ⟹ `ok: true`, empty set
 * (a gitlink here is genuinely undeclared / stray).
 *
 * Load this ONCE per level and reuse the set, rather than one `git config` scan
 * per gitlink (round 9, P2: the per-gitlink lookup was O(N²) + N processes).
 */
export async function readDeclaredSubmodulePaths(
  levelPath: string,
): Promise<{ ok: boolean; paths: Set<string> }> {
  if (!existsSync(join(levelPath, '.gitmodules'))) return { ok: true, paths: new Set() }
  const r = await runGit(levelPath, [
    'config',
    '-f',
    '.gitmodules',
    '--get-regexp',
    String.raw`^submodule\..*\.path$`,
  ])
  // 0 = matches · 1 = no matching keys (valid, possibly empty) · >1 = parse error.
  if (r.exitCode > 1) return { ok: false, paths: new Set() }
  const paths = new Set<string>()
  for (const line of r.stdout.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    // Validate the submodule NAME, not just extract the path (Codex review
    // round 10, P1): `git config --get-regexp` matches `submodule..path` for an
    // `[submodule ""]` subsection (exit 0, parseable), but git's own submodule
    // machinery IGNORES an empty-name entry. Without this check a crafted
    // `.gitmodules` would re-classify a stray gitlink as managed and let
    // `checkout --detach` rewind it — the very thing the round-8 guard exists
    // to prevent. `submoduleNameForPath` has always required a non-empty name.
    // `[\s\S]` not `.` (round 11, P2): git accepts subsection names containing
    // U+2028/U+2029, which JS `.` does not match — a `.`-based regex would go
    // null on such a valid name and drop a MANAGED submodule's update.
    const key = line.slice(0, sp)
    const m = /^submodule\.([\s\S]*)\.path$/.exec(key)
    if (m?.[1] === undefined || m[1] === '') continue
    const p = line.slice(sp + 1).trim()
    if (p !== '') paths.add(p)
  }
  return { ok: true, paths }
}

/**
 * RFC-210 — the `.gitmodules` NAME for a submodule path at ONE level (path
 * relative to `levelPath`, no slashes across gitlink boundaries). Needed to
 * address `submodule.<name>.url` config; name and path differ whenever the
 * submodule was added with a custom `--name` or later moved.
 */
export async function submoduleNameForPath(
  levelPath: string,
  relPath: string,
): Promise<string | null> {
  const declared = await runGit(levelPath, [
    'config',
    '-f',
    '.gitmodules',
    '--get-regexp',
    String.raw`^submodule\..*\.path$`,
  ])
  if (declared.exitCode !== 0) return null
  for (const line of declared.stdout.split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    if (line.slice(sp + 1).trim() !== relPath) continue
    const key = line.slice(0, sp)
    const m = /^submodule\.(.*)\.path$/.exec(key)
    if (m?.[1] !== undefined && m[1] !== '') return m[1]
  }
  return null
}

/**
 * RFC-210 impl-gate A3-fix — initialize + check out a submodule whose gitlink
 * exists only as tree data, sourcing objects from the shared POOL instead of
 * the network.
 *
 * `git submodule update --init` clones from `submodule.<name>.url` and then
 * direct-fetches the wanted sha — both steps that fail for a commit that only
 * exists locally (a node's own work is on no remote; measured:
 * `upload-pack: not our ref <sha>`). The url is therefore pointed at the pool
 * for the duration of the clone and restored via `submodule sync` afterwards.
 *
 * The gitlink is injected into the REAL index only transiently (`submodule
 * update` reads its target sha from the index) and the prior index state is
 * restored in `finally`, so the materialized delta stays UNSTAGED (D23/D28).
 *
 * Never throws; the caller decides how a failure escalates.
 */
export async function attachSubmoduleFromPool(
  levelPath: string,
  args: { relPath: string; sha: string; pool: string },
): Promise<{ ok: boolean; error: string | null }> {
  const { relPath, sha, pool } = args
  const name = await submoduleNameForPath(levelPath, relPath)
  if (name === null) {
    return { ok: false, error: `no .gitmodules entry for '${relPath}'` }
  }
  const prior = await runGit(levelPath, ['ls-files', '-s', '--', relPath])
  const priorLine = prior.exitCode === 0 ? prior.stdout.trimEnd() : ''
  const fail = (msg: string): { ok: false; error: string } => ({
    ok: false,
    error: redactGitUrl(msg.trim()) || 'submodule attach failed',
  })
  const body = async (): Promise<{ ok: boolean; error: string | null }> => {
    const inject = await runGit(levelPath, [
      'update-index',
      '--add',
      '--cacheinfo',
      `160000,${sha},${relPath}`,
    ])
    if (inject.exitCode !== 0) return fail(`update-index: ${inject.stderr}`)
    const init = await runGit(levelPath, ['submodule', 'init', '--', relPath])
    if (init.exitCode !== 0) return fail(`submodule init: ${init.stderr}`)
    const url = await runGit(levelPath, ['config', `submodule.${name}.url`, pool])
    if (url.exitCode !== 0) return fail(`config url: ${url.stderr}`)
    // `-c protocol.file.allow=always` is REQUIRED, command-scoped: since the
    // 2.38.4 lockdown git rejects local-path clone URLs by default (`fatal:
    // transport 'file' not allowed`), and the pool url IS a local path. The
    // pool is platform-owned — this does not widen trust for user-configured
    // submodule urls, which never pass through here (Codex review round 2, P1).
    const update = await runGit(levelPath, [
      '-c',
      'protocol.file.allow=always',
      'submodule',
      'update',
      '--init',
      '--checkout',
      '--',
      relPath,
    ])
    // Restore the real url from .gitmodules whether or not the update worked —
    // leaving the pool as the recorded remote would leak an internal path into
    // the user's config and, worse, make a later auto-commit-push publish the
    // submodule INTO THE POOL while the parent's gitlink claims the real
    // remote has it. A failed restore therefore fails the attach even when
    // the update itself succeeded (Codex review round 2, P2).
    const sync = await runGit(levelPath, ['submodule', 'sync', '--', relPath])
    if (update.exitCode !== 0) return fail(`submodule update: ${update.stderr}`)
    if (sync.exitCode !== 0) return fail(`submodule sync (url restore): ${sync.stderr}`)
    const head = await runGit(join(levelPath, relPath), ['rev-parse', 'HEAD'])
    if (head.exitCode !== 0 || head.stdout.trim() !== sha) {
      return fail(`attached HEAD is ${head.stdout.trim() || '(none)'}, wanted ${sha}`)
    }
    return { ok: true, error: null }
  }
  const result = await body()
  // The transient index injection MUST be rolled back — a leftover entry
  // breaks the unstaged-materialization contract (D23/D28) and can replace
  // the caller's staged state. A failed restore (index.lock contention, fs
  // error) turns the whole attach into a failure even if the body succeeded
  // (Codex review round 2, P2).
  const restored =
    priorLine === ''
      ? await runGit(levelPath, ['update-index', '--force-remove', '--', relPath])
      : await runGit(levelPath, ['update-index', '--index-info'], { stdin: priorLine + '\n' })
  if (restored.exitCode !== 0) {
    return fail(
      `index restore: ${restored.stderr.trim()}${result.error !== null ? ` (after: ${result.error})` : ''}`,
    )
  }
  return result
}

/** Read the alternates file as a list of object-dir paths (missing file ⟹ []). */
function readAlternates(altFile: string): string[] {
  try {
    return readFileSync(altFile, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s !== '' && !s.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Make `worktreePath`'s copy of `subPath` borrow objects from `poolDir`.
 *
 * `submodule update --reference` only takes effect on a FIRST-TIME clone; on an
 * already-initialized module dir it is a silent no-op (measured). Since every
 * pre-existing worktree and every `materializeTree` call site operates on an
 * already-initialized tree, the alternates file is written explicitly here.
 *
 * The write is a UNION, never a truncate — a module dir may already borrow from
 * somewhere the user configured, and clobbering that would break their objects.
 * Idempotent. Never throws.
 */
export async function ensureSubmoduleAlternates(
  worktreePath: string,
  subPath: string,
  poolDir: string,
): Promise<{ ok: boolean; error: string | null }> {
  const gitDir = await submoduleGitDir(worktreePath, subPath)
  if (gitDir === null) {
    return { ok: false, error: `submodule '${subPath}' has no git dir` }
  }
  const poolObjects = join(poolDir, 'objects')
  if (!existsSync(poolObjects)) {
    return { ok: false, error: `pool objects dir missing: ${poolObjects}` }
  }
  const altFile = join(gitDir, 'objects', 'info', 'alternates')
  const existing = readAlternates(altFile)
  if (existing.includes(poolObjects)) return { ok: true, error: null }
  try {
    mkdirSync(dirname(altFile), { recursive: true })
    writeFileSync(altFile, [...existing, poolObjects].join('\n') + '\n', 'utf8')
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Publish `sha` from `fromGitDir` into `poolDir` AND anchor it with `keepRef`.
 *
 * The two steps are inseparable: `git fetch <dir> <sha>` writes FETCH_HEAD only
 * and creates no ref, so the fetched objects are unreachable in the pool and a
 * plain `git gc` deletes them once past `gc.pruneExpire` (two weeks by default —
 * task worktrees outlive that). Losing them leaves the canonical submodule at
 * `bad object HEAD`, which makes the SUPERPROJECT's `git status` fail outright
 * and takes `snapshotFullState` down with it.
 *
 * A failed `update-ref` is therefore an error, never a warning.
 */
export async function pushObjectsToPool(
  poolDir: string,
  fromGitDir: string,
  sha: string,
  keepRef: string,
): Promise<{ ok: boolean; error: string | null }> {
  const fetched = await runGit(poolDir, ['fetch', '--no-tags', fromGitDir, sha])
  if (fetched.exitCode !== 0) {
    return {
      ok: false,
      error: redactGitUrl(fetched.stderr.trim()) || 'submodule object fetch failed',
    }
  }
  const pinned = await runGit(poolDir, ['update-ref', keepRef, sha])
  if (pinned.exitCode !== 0) {
    return {
      ok: false,
      error: redactGitUrl(pinned.stderr.trim()) || `update-ref ${keepRef} failed`,
    }
  }
  return { ok: true, error: null }
}

/** A submodule's state at a point in time, restorable by `rollbackSubmodule`. */
export interface SubSnapshot {
  /** HEAD before the platform touched anything. */
  head: string
  /** Full-state snapshot commit (tracked + untracked). */
  snapshot: string
  /** Ref keeping `snapshot` reachable — a dangling commit is one gc away from gone. */
  pinRef: string
}

/**
 * Snapshot one submodule's complete state (HEAD + tracked + untracked) without
 * touching its real index, HEAD, or working tree.
 *
 * Delegates to `snapshotFullState` — a submodule is an ordinary git working tree,
 * and forking a second snapshot implementation would be one more thing to drift.
 * `pinRef` is REQUIRED: the snapshot is a dangling commit otherwise.
 */
export async function snapshotSubmodule(subPath: string, pinRef: string): Promise<SubSnapshot> {
  const head = await runGit(subPath, ['rev-parse', 'HEAD'])
  if (head.exitCode !== 0) {
    throw new Error(
      `submodule snapshot: rev-parse HEAD failed in ${subPath}: ${head.stderr.trim()}`,
    )
  }
  const snapshot = await snapshotFullState(subPath, { pinRef })
  // Impl-gate A5-fix: read the ref BACK and require it to resolve to the
  // snapshot before anyone treats this as a recovery point. `snapshotFullState`
  // now throws on a failed `update-ref`, but a pin that raced a concurrent
  // writer (or landed on a case-folding filesystem alias) can still point
  // elsewhere — and the only caller of this function is about to `checkout -f`
  // away the user's uncommitted work on the strength of this snapshot.
  const pinned = await runGit(subPath, ['rev-parse', '--verify', '--quiet', `${pinRef}^{commit}`])
  if (pinned.exitCode !== 0 || pinned.stdout.trim() !== snapshot) {
    throw new Error(
      `submodule snapshot: pin ${pinRef} resolves to '${pinned.stdout.trim()}', expected ${snapshot}`,
    )
  }
  return { head: head.stdout.trim(), snapshot, pinRef }
}

/**
 * Restore a submodule to a snapshot, undoing any platform-authored commits and
 * bringing back both tracked edits and untracked files. Drops the pin afterwards.
 *
 * NOTE: this cannot reach anything already pushed — see RFC-210 §6.3.
 */
export async function rollbackSubmodule(subPath: string, snap: SubSnapshot): Promise<void> {
  const reset = await runGit(subPath, ['reset', '--hard', snap.head])
  if (reset.exitCode !== 0) {
    throw new Error(`submodule rollback: reset --hard failed in ${subPath}: ${reset.stderr.trim()}`)
  }
  const read = await runGit(subPath, ['read-tree', `${snap.snapshot}^{tree}`])
  if (read.exitCode !== 0) {
    throw new Error(`submodule rollback: read-tree failed in ${subPath}: ${read.stderr.trim()}`)
  }
  const co = await runGit(subPath, ['checkout-index', '-f', '-a'])
  if (co.exitCode !== 0) {
    throw new Error(`submodule rollback: checkout-index failed in ${subPath}: ${co.stderr.trim()}`)
  }
  const mixed = await runGit(subPath, ['reset', '--mixed', snap.head])
  if (mixed.exitCode !== 0) {
    throw new Error(
      `submodule rollback: reset --mixed failed in ${subPath}: ${mixed.stderr.trim()}`,
    )
  }
  // Best-effort: the snapshot has served its purpose; leaving the ref behind
  // would accumulate dangling commits in the user's submodule odb.
  await runGit(subPath, ['update-ref', '-d', snap.pinRef])
}

/**
 * Restore a whole submodule tree.
 *
 * Two passes, because rolling a nested submodule back moves its HEAD and thereby
 * DIRTIES its parent's gitlink (measured: parent shows ' M nested'):
 *   1. bottom-up — restore each submodule's own content;
 *   2. top-down  — re-point each gitlink at the snapshotted head, clearing the
 *      dirt pass 1 just created.
 */
export async function rollbackSubmodulesRecursive(
  worktreePath: string,
  snapshots: Record<string, SubSnapshot>,
): Promise<void> {
  const paths = Object.keys(snapshots).sort(
    (a, b) => b.split('/').length - a.split('/').length || b.localeCompare(a),
  )
  for (const p of paths) {
    await rollbackSubmodule(join(worktreePath, p), snapshots[p] as SubSnapshot)
  }
  for (const p of [...paths].reverse()) {
    const snap = snapshots[p] as SubSnapshot
    await runGit(join(worktreePath, p), ['checkout', '--detach', snap.head])
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RFC-210 §2.3 — per-submodule three-way merge.
//
// git does NOT do this for us. A superproject-level `merge-tree` that sees a
// gitlink moved on BOTH sides gives up with exit 1 and
//   "Recursive merging with submodules currently only supports trivial cases."
// Running the same command INSIDE the submodule merges cleanly (measured: two
// nodes editing different lines of one file merge to a union), so the recursion
// has to be driven from here.
// ─────────────────────────────────────────────────────────────────────────────

export interface SubMergeResult {
  /** Commit the submodule should end up at, or null when the merge conflicted. */
  merged: string | null
  /** True when nothing had to be done (all three sides agree, or one side is idle). */
  trivial: boolean
  /** Raw stderr for a conflicted / failed merge. */
  error: string | null
}

/**
 * Merge one submodule's `ours` and `theirs` over `base`, inside `poolDir`.
 *
 * Result parentage matters: the merged commit MUST have `ours` as an ancestor,
 * otherwise the superproject's own merge still refuses the gitlink. Measured on
 * git 2.50.1 — `-p theirs` alone ⟹ superproject exit 1; `-p ours` alone,
 * `-p ours -p theirs`, and `-p theirs -p ours` all ⟹ exit 0. So the real
 * invariant is ancestry, not parent count or order; two parents are used anyway
 * so `theirs` stays reachable and the submodule's history keeps both lineages.
 */
export async function mergeSubmoduleTrees(
  poolDir: string,
  args: { base: string; ours: string; theirs: string; message?: string },
): Promise<SubMergeResult> {
  const { base, ours, theirs } = args
  if (ours === theirs) return { merged: ours, trivial: true, error: null }
  // One side never moved ⟹ take the other verbatim; no merge commit needed.
  if (ours === base) return { merged: theirs, trivial: true, error: null }
  if (theirs === base) return { merged: ours, trivial: true, error: null }

  const mt = await runGit(poolDir, [
    'merge-tree',
    '--write-tree',
    `--merge-base=${base}`,
    ours,
    theirs,
  ])
  if (mt.exitCode !== 0) {
    // exit 1 = real conflict; anything higher (e.g. an unreadable base) is a
    // hard error the caller must NOT mistake for "needs a merge agent".
    return { merged: null, trivial: false, error: mt.stdout.trim() || mt.stderr.trim() }
  }
  const tree = mt.stdout.split('\n')[0]?.trim()
  if (tree === undefined || tree === '') {
    return { merged: null, trivial: false, error: 'merge-tree produced no tree' }
  }
  const commit = await runGit(
    poolDir,
    ['commit-tree', tree, '-p', ours, '-p', theirs, '-m', args.message ?? 'aw: submodule merge'],
    { env: AW_INTERNAL_GIT_IDENTITY },
  )
  if (commit.exitCode !== 0) {
    return { merged: null, trivial: false, error: commit.stderr.trim() }
  }
  return { merged: commit.stdout.trim(), trivial: false, error: null }
}

/**
 * Rewrite one gitlink inside `treeish`'s tree and return a NEW commit carrying it.
 *
 * Used to fold a per-submodule merge result back into the node's `theirs` tree so
 * the superproject-level merge only ever sees the trivial "one side moved" shape.
 * Uses a scratch index so the caller's real index/HEAD/worktree are untouched.
 */
export async function rewriteGitlinkInCommit(
  repoPath: string,
  args: { commit: string; subPath: string; sha: string; message?: string },
): Promise<string | null> {
  const idx = join(tmpdir(), `aw-gitlink-idx-${process.pid}-${gitlinkIdxCounter++}`)
  const env = { GIT_INDEX_FILE: idx }
  try {
    const read = await runGit(repoPath, ['read-tree', `${args.commit}^{tree}`], { env })
    if (read.exitCode !== 0) return null
    const upd = await runGit(
      repoPath,
      ['update-index', '--cacheinfo', `160000,${args.sha},${args.subPath}`],
      { env },
    )
    if (upd.exitCode !== 0) return null
    const wt = await runGit(repoPath, ['write-tree'], { env })
    if (wt.exitCode !== 0) return null
    const commit = await runGit(
      repoPath,
      [
        'commit-tree',
        wt.stdout.trim(),
        '-p',
        args.commit,
        '-m',
        args.message ?? 'aw: submodule gitlink',
      ],
      { env: AW_INTERNAL_GIT_IDENTITY },
    )
    return commit.exitCode === 0 ? commit.stdout.trim() : null
  } finally {
    await rm(idx, { force: true }).catch(() => {
      /* best-effort */
    })
  }
}

let gitlinkIdxCounter = 0
