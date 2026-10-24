// RFC-239 §3.5 — full-text file content for the markdown rendered-diff view.
// `MarkdownDiffView` needs COMPLETE left/right documents; the unified patch
// cannot reconstruct them, and the pre-existing file API only serves the
// worktree (after) side.
//
// Two hard requirements from the design gate:
//   - P0-2: rename-aware sides — base reads `basePath ?? path` (the caller
//     passes the structural diff's `renamedFrom`), and BOTH sides answer a
//     missing file with 200 `{exists:false}` (a pure add has no base side, a
//     pure delete has no worktree side; neither is an error).
//   - P0-3: the worktree side must not check-then-reopen (the resident
//     `readWorktreeFile` pattern) — a live agent can swap a symlink between
//     the containment check and the read. We open FIRST (O_NOFOLLOW on the
//     already-realpath'd target), then verify regular-file/size/NUL on the
//     file handle and read from that same handle.

import { basename } from 'node:path'
import { isSingleRootRepository, parseRepoKeyWire } from '@agent-workflow/shared'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { TaskWorktreeLocator } from '@/modules/task-execution/public/queries'
import {
  composeLocalRepositoryRevisionContent,
  openContainedFileWithin,
  type ContainedFileHooks,
  type ContainedRead,
  type RepositoryRevisionContentFactory,
} from '@/modules/source-control/public/participants'
import { canonicalRepoKeys } from '@/services/repoLabels'
import { MAX_ANALYZE_BYTES } from '@/services/structuralDiff/baseline'

/** Same ceiling as the structural analyzer (1.5 MiB) — beyond it the rendered
 *  view falls back to the textual diff anyway. */
export const FILE_CONTENT_MAX_BYTES = MAX_ANALYZE_BYTES

export interface FileContentResult {
  exists: boolean
  content?: string
  size?: number
}

export type { ContainedFileHooks }

/**
 * Handle-first contained read of one worktree file under the rendered-view
 * ceiling. RFC-370 §10 V16 moved the primitive into Source Control's local
 * revision content (`openContainedFileWithin`), which the worktree side of this
 * view now reads through; this keeps the original entry point.
 */
export function openContainedFile(
  root: string,
  relPath: string,
  hooks?: ContainedFileHooks,
): ContainedRead {
  return openContainedFileWithin(root, relPath, FILE_CONTENT_MAX_BYTES, hooks)
}

export interface FileContentDeps {
  /** RFC-370 §10 V16 — the selected revision content; this host's worktrees when absent. */
  readonly content?: RepositoryRevisionContentFactory
  /** Test seam of the standalone contained read. */
  readonly hooks?: ContainedFileHooks
}

/**
 * One side of a task file for the rendered diff. Non-single-root layouts select the
 * repo by canonical label (same labels the diff markers / structural prefixes
 * carry); single-root tasks may omit `repo`.
 */
export async function getTaskFileContent(
  locator: TaskWorktreeLocator,
  taskId: string,
  q: { path: string; side: 'base' | 'worktree'; basePath?: string; repo?: string },
  deps: FileContentDeps = {},
): Promise<FileContentResult> {
  if (q.path === '') {
    throw new ValidationError('file-content-missing-path', 'path query param required')
  }
  const task = await locator.find(taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  let worktreePath = task.worktreePath
  let baseCommit = task.baseCommit
  const mounts = task.repos.length === 0 ? [''] : task.repos.map((repo) => repo.mountPath)
  if (!isSingleRootRepository(mounts)) {
    if (q.repo === undefined || q.repo === '') {
      throw new ValidationError(
        'file-content-repo-required',
        'repo query param required for a multi-repo task',
      )
    }
    const labels = canonicalRepoKeys(task.repos)
    // RFC-258 (gate F-04): the ROOT repo's canonical key is '' which a query
    // param cannot carry — accept its RFC-248 wire alias '.' here too, so the
    // source viewer can read root-repo files in a multi-repo task.
    const idx = labels.indexOf(parseRepoKeyWire(q.repo))
    const repo = idx >= 0 ? task.repos[idx] : undefined
    if (repo === undefined) {
      throw new NotFoundError('file-content-repo-not-found', `repo '${q.repo}' not found`)
    }
    worktreePath = repo.worktreePath
    baseCommit = repo.baseCommit
  }

  const content = (
    deps.content ??
    composeLocalRepositoryRevisionContent(deps.hooks === undefined ? {} : { hooks: deps.hooks })
  ).bind(worktreePath)

  if (q.side === 'base') {
    if (baseCommit === null || baseCommit === '') {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot read the base side`,
        409,
      )
    }
    // basePath ?? path: a renamed file's base side lives at its OLD path
    // (design gate P0-2) — the caller passes the structural renamedFrom.
    const basePath = q.basePath ?? q.path
    const blob = (
      await content.readRevision({
        rev: baseCommit,
        paths: [basePath],
        maxBytes: FILE_CONTENT_MAX_BYTES,
      })
    ).get(basePath) ?? { kind: 'absent' as const }
    if (blob.kind === 'absent') return { exists: false }
    if (blob.kind === 'oversized') {
      throw new DomainError('file-content-oversized', 'file exceeds the rendered-view limit', 413)
    }
    if (blob.kind === 'binary' || blob.content.includes('\x00')) {
      throw new DomainError('file-content-binary', 'binary file has no rendered view', 415)
    }
    return { exists: true, content: blob.content, size: blob.size }
  }

  const read = await content.readWorktree({ path: q.path, maxBytes: FILE_CONTENT_MAX_BYTES })
  switch (read.kind) {
    case 'text':
      return { exists: true, content: read.content, size: read.size }
    case 'absent':
      return { exists: false }
    case 'outside':
      throw new ValidationError(
        'file-content-path-escapes',
        `path '${basename(q.path)}' resolves outside the worktree`,
      )
    case 'oversized':
      throw new DomainError('file-content-oversized', 'file exceeds the rendered-view limit', 413)
    case 'binary':
      throw new DomainError('file-content-binary', 'binary file has no rendered view', 415)
  }
}
