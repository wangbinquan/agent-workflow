// RFC-085 T3 — worktree-backed call-target expansion.
//
// Wraps the pure `expandMethod` with worktree I/O: a cached, shallow class→file
// index over the whole repo (so the chain can穿透 into unchanged files) + a
// path-safe file reader. The index is cheap (regex over decl lines) and cached
// per worktree path. Best-effort by design.
//
// RFC-370 §10 V16 — the index and the file reads come from the selected
// revision content (the native worktree, or a hosted task volume).

import { isSingleRootRepository, type CallTarget } from '@agent-workflow/shared'
import type { TaskCallGraphWorkspaceReadModel } from '@/modules/task-execution/public/types'
import {
  composeLocalRepositoryRevisionContent,
  type RepositoryClassIndex,
  type RepositoryRevisionContent,
  type RepositoryRevisionContentFactory,
} from '@/modules/source-control/public/participants'
import { DomainError, NotFoundError } from '@/util/errors'
import { resolveLang } from '../lang/grammars'
import { expandMethod, type ExpandCtx } from './service'

const MAX_FILE_BYTES = 2_000_000

const _indexCache = new Map<string, Promise<RepositoryClassIndex>>()

/** Build (and cache per worktree) the class→file index by shallow-scanning every
 *  source file's declaration lines. A failed build is not cached. */
function classIndexFor(
  root: string,
  content: RepositoryRevisionContent,
): Promise<RepositoryClassIndex> {
  const cached = _indexCache.get(root)
  if (cached !== undefined) return cached
  const built = content.classIndex()
  _indexCache.set(root, built)
  built.catch(() => {
    if (_indexCache.get(root) === built) _indexCache.delete(root)
  })
  return built
}

/** Drop a worktree's cached index (e.g. after it changes/GCs). */
export function invalidateCallGraphIndex(root: string): void {
  _indexCache.delete(root)
}

/** Path-safe reader: only text files inside the worktree. */
function makeReader(content: RepositoryRevisionContent): (p: string) => Promise<string | null> {
  return async (p) => {
    const read = await content.readWorktree({ path: p, maxBytes: MAX_FILE_BYTES })
    return read.kind === 'text' ? read.content : null
  }
}

/** Build an ExpandCtx over a worktree directory (testable seam). */
export async function worktreeExpandCtx(
  root: string,
  content: RepositoryRevisionContent = composeLocalRepositoryRevisionContent().bind(root),
): Promise<ExpandCtx> {
  return {
    readFile: makeReader(content),
    classIndex: await classIndexFor(root, content),
    grammarFor: resolveLang,
    maxBytes: MAX_FILE_BYTES,
  }
}

/**
 * RFC-089 P4 — split a (possibly repo-label-prefixed) call-chain ref into its
 * repo dir + the in-repo ref. In a multi-repo task the graph's refs are
 * `${mountPath}/${filePath}#${qn}` (mergeStructuralDiffs prefixes them);
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
  workspaceReadModel: TaskCallGraphWorkspaceReadModel,
  taskId: string,
  methodRef: string,
  /** RFC-370 §10 V16 — the selected revision content; this host's worktrees when absent. */
  revisionContent: RepositoryRevisionContentFactory = composeLocalRepositoryRevisionContent(),
): Promise<CallTarget[]> {
  const workspace = await workspaceReadModel.find(taskId)
  if (workspace === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  // Single root: expand against the task worktree with the ref as-is. Other
  // layouts (RFC-089 P4): the ref is `${mountPath}/…`, so pick that repo's worktree
  // and strip the prefix before expanding, then re-prefix the results so the
  // chain keeps resolving within the same repo on the next click.
  let worktreePath = workspace.worktreePath
  let innerRef = methodRef
  let label: string | null = null
  const mounts = workspace.repos.length === 0 ? [''] : workspace.repos.map((repo) => repo.mountPath)
  if (!isSingleRootRepository(mounts)) {
    const split = splitRepoRef(mounts, methodRef)
    if (split.dir === null) {
      throw new NotFoundError(
        'call-target-repo-unresolved',
        `call-chain ref '${methodRef}' does not match any repo in task '${taskId}'`,
      )
    }
    const repo = workspace.repos.find((candidate) => candidate.mountPath === split.dir)!
    worktreePath = repo.worktreePath
    innerRef = split.innerRef
    label = split.dir
  }

  const content = revisionContent.bind(worktreePath)
  if ((await content.presence()) !== 'git') {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${worktreePath}' is unavailable (missing or no longer a git repository); cannot expand call chain`,
      410,
    )
  }
  const ctx = await worktreeExpandCtx(worktreePath, content)
  const targets = await expandMethod(innerRef, ctx)
  return label === null ? targets : targets.map((t) => reprefixTarget(label, t))
}
