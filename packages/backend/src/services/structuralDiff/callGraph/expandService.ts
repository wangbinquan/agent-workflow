// RFC-085 T3 — worktree-backed call-target expansion.
//
// Wraps the pure `expandMethod` with worktree I/O: a cached, shallow class→file
// index over the whole repo (so the chain can穿透 into unchanged files) + a
// path-safe file reader. The index is cheap (regex over decl lines) and cached
// per worktree path. Best-effort by design.

import { readFile as fsReadFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import type { DbClient } from '@/db/client'
import type { CallTarget } from '@agent-workflow/shared'
import { getTask } from '@/services/task'
import { DomainError, NotFoundError } from '@/util/errors'
import { isGitWorkTree } from '@/util/git'
import { resolveLang } from '../lang/grammars'
import { scanClassDecls, buildClassIndex } from './classIndex'
import { expandMethod, type ExpandCtx } from './service'

/** Normalize an OS-native relative path to forward slashes. Call-graph refs
 *  (`${file}#${qn}`) and ownerClass ids are stored / surfaced as data, so they
 *  must be portable: on Windows `path.relative` yields `src\OrderService.java`,
 *  which would silently mismatch the `src/...` shape tests and the rest of the
 *  platform expect. RFC-W001. */
function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  'vendor',
])
const MAX_INDEX_FILES = 8000
const MAX_FILE_BYTES = 2_000_000

const _indexCache = new Map<string, Promise<Map<string, string[]>>>()

/** Tracked source files under `root` (supported extensions only), skipping
 *  common build/vendor dirs. Bounded by MAX_INDEX_FILES. */
async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_INDEX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= MAX_INDEX_FILES) return
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name))
      } else if (e.isFile() && resolveLang(e.name) !== null) {
        out.push(toPosix(relative(root, join(dir, e.name))))
      }
    }
  }
  await walk(root)
  return out
}

/** Build (and cache per worktree) the class→file index by shallow-scanning every
 *  source file's declaration lines. */
function classIndexFor(root: string): Promise<Map<string, string[]>> {
  const cached = _indexCache.get(root)
  if (cached !== undefined) return cached
  const built = (async (): Promise<Map<string, string[]>> => {
    const files = await listSourceFiles(root)
    const perFile: Array<{ file: string; names: string[] }> = []
    for (const f of files) {
      try {
        const src = await fsReadFile(join(root, f), 'utf8')
        if (src.length <= MAX_FILE_BYTES) perFile.push({ file: f, names: scanClassDecls(f, src) })
      } catch {
        /* skip unreadable */
      }
    }
    return buildClassIndex(perFile)
  })()
  _indexCache.set(root, built)
  return built
}

/** Drop a worktree's cached index (e.g. after it changes/GCs). */
export function invalidateCallGraphIndex(root: string): void {
  _indexCache.delete(root)
}

/** Path-safe reader: only files inside `root`. */
function makeReader(root: string): (p: string) => Promise<string | null> {
  const rootResolved = resolve(root)
  return async (p) => {
    const abs = resolve(root, p)
    if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null // traversal guard
    try {
      return await fsReadFile(abs, 'utf8')
    } catch {
      return null
    }
  }
}

/** Build an ExpandCtx over a worktree directory (testable seam). */
export async function worktreeExpandCtx(root: string): Promise<ExpandCtx> {
  return {
    readFile: makeReader(root),
    classIndex: await classIndexFor(root),
    grammarFor: resolveLang,
    maxBytes: MAX_FILE_BYTES,
  }
}

/**
 * RFC-089 P4 — split a (possibly repo-label-prefixed) call-chain ref into its
 * repo dir + the in-repo ref. In a multi-repo task the graph's refs are
 * `${worktreeDirName}/${filePath}#${qn}` (mergeStructuralDiffs prefixes them);
 * call expansion must run in THAT repo's worktree against the UN-prefixed ref.
 * Longest matching `${dir}/` prefix wins; no match → `{ dir: null, innerRef }`.
 * Pure (exported for tests).
 */
export function splitRepoRef(
  repoDirs: readonly string[],
  ref: string,
): { dir: string | null; innerRef: string } {
  let best: string | null = null
  for (const dir of repoDirs) {
    if (dir !== '' && ref.startsWith(`${dir}/`) && (best === null || dir.length > best.length)) {
      best = dir
    }
  }
  return best === null
    ? { dir: null, innerRef: ref }
    : { dir: best, innerRef: ref.slice(best.length + 1) }
}

/** Re-apply a repo label to one id segment (before `#` for refs / `::` for
 *  ownerClass) so the next lazy expand resolves back to the same repo. */
function prefixSeg(label: string, id: string, delim: string): string {
  const i = id.indexOf(delim)
  return i < 0 ? `${label}/${id}` : `${label}/${id.slice(0, i)}${id.slice(i)}`
}

function reprefixTarget(label: string, t: CallTarget): CallTarget {
  return {
    ...t,
    ref: t.ref !== undefined ? prefixSeg(label, t.ref, '#') : undefined,
    ownerClass: t.ownerClass !== undefined ? prefixSeg(label, t.ownerClass, '::') : undefined,
  }
}

/** Resolve the task's worktree + expand one method's direct callees. */
export async function getCallTargets(
  db: DbClient,
  taskId: string,
  methodRef: string,
): Promise<CallTarget[]> {
  const task = await getTask(db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)

  // Single-repo: expand against the task worktree with the ref as-is. Multi-repo
  // (RFC-089 P4): the ref is `${worktreeDirName}/…`, so pick that repo's worktree
  // and strip the prefix before expanding, then re-prefix the results so the
  // chain keeps resolving within the same repo on the next click.
  let worktreePath = task.worktreePath
  let innerRef = methodRef
  let label: string | null = null
  if (task.repoCount > 1) {
    const split = splitRepoRef(
      task.repos.map((r) => r.worktreeDirName),
      methodRef,
    )
    if (split.dir === null) {
      throw new NotFoundError(
        'call-target-repo-unresolved',
        `call-chain ref '${methodRef}' does not match any repo in task '${taskId}'`,
      )
    }
    const repo = task.repos.find((r) => r.worktreeDirName === split.dir)!
    worktreePath = repo.worktreePath
    innerRef = split.innerRef
    label = split.dir
  }

  if (!(await isGitWorkTree(worktreePath))) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${worktreePath}' is unavailable (missing or no longer a git repository); cannot expand call chain`,
      410,
    )
  }
  const ctx = await worktreeExpandCtx(worktreePath)
  const targets = await expandMethod(innerRef, ctx)
  return label === null ? targets : targets.map((t) => reprefixTarget(label, t))
}
