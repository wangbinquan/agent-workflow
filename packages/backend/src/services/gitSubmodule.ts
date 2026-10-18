// RFC-034 / RFC-210: submodule topology, shared pools, rollback and merge orchestration.
// RFC-377: git primitives live in util/git; this facade preserves production imports.

import { redactGitUrl } from '@agent-workflow/shared'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  AW_INTERNAL_GIT_IDENTITY,
  runGit,
  resolveSubmodulePool,
  submoduleGitDir,
  subSlug,
  type SubSnapshot,
} from '@/util/git'

export {
  detectSubmodules,
  resolveSubmodulePool,
  subSlug,
  submoduleGitDir,
  syncSubmodules,
} from '@/util/git'
export type { SubmoduleMode } from '@/util/git'
import type { SubmoduleEntry } from '@/modules/source-control/public/types'

// ─────────────────────────────────────────────────────────────────────────────
// RFC-210: submodule topology, shared object pool, and per-submodule snapshots.
//
// Git primitives live in `util/git.ts`; topology and orchestration remain here.
// Callers inject submodule settings and capability policy into the primitives,
// so the git leaf never imports this facade or the configuration service.
// ─────────────────────────────────────────────────────────────────────────────

export type { SubmoduleEntry } from '@/modules/source-control/public/types'
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
