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

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'
import { parseRepoKeyWire } from '@agent-workflow/shared'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { readBlobAtRef } from '@/util/git'
import type { DbClient } from '@/db/client'
import { getTask } from '@/services/task'
import { canonicalRepoKeys } from '@/services/repoLabels'
import { MAX_ANALYZE_BYTES } from '@/services/structuralDiff/baseline'

/** Same ceiling as the structural analyzer (1.5 MiB) — beyond it the rendered
 *  view falls back to the textual diff anyway. */
export const FILE_CONTENT_MAX_BYTES = MAX_ANALYZE_BYTES

const NUL_PROBE_BYTES = 8192

export interface FileContentResult {
  exists: boolean
  content?: string
  size?: number
}

/** Test seam: invoked between containment resolution and open(2) so a test can
 *  swap the resolved path for a symlink and prove the open still refuses. */
export interface ContainedFileHooks {
  beforeOpen?: () => void
}

type ContainedRead =
  | { kind: 'ok'; content: string; size: number }
  | { kind: 'not-found' }
  | { kind: 'outside' }
  | { kind: 'oversized'; size: number }
  | { kind: 'binary' }

function hasNul(buf: Buffer): boolean {
  const probe = buf.subarray(0, NUL_PROBE_BYTES)
  return probe.includes(0)
}

/**
 * Handle-first contained read. The containment decision is made on the
 * realpath'd target; the open then uses O_NOFOLLOW so a symlink swapped in
 * AFTER that decision (the classic TOCTOU) is refused by the kernel instead of
 * silently followed. All subsequent checks (regular file, size, NUL) run on
 * the SAME file description we read from. A directory-segment swap deeper in
 * the path is not closed by O_NOFOLLOW (needs openat2/RESOLVE_BENEATH,
 * unavailable on macOS) — tracked in docs/audit-backlog.md.
 */
export function openContainedFile(
  root: string,
  relPath: string,
  hooks?: ContainedFileHooks,
): ContainedRead {
  if (relPath === '' || isAbsolute(relPath)) return { kind: 'outside' }
  if (relPath.split('/').some((seg) => seg === '..')) return { kind: 'outside' }

  let rootReal: string
  try {
    rootReal = realpathSync(resolve(root))
  } catch {
    return { kind: 'not-found' } // worktree itself is gone
  }
  let resolved: string
  try {
    resolved = realpathSync(join(rootReal, relPath))
  } catch {
    return { kind: 'not-found' }
  }
  if (resolved !== rootReal && !resolved.startsWith(rootReal + sep)) {
    return { kind: 'outside' }
  }

  hooks?.beforeOpen?.()

  let fd: number
  try {
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (err) {
    // ELOOP = the final component became a symlink after resolution — the
    // exact race we refuse. Anything else (vanished file) is a plain miss.
    const code = (err as NodeJS.ErrnoException).code
    return code === 'ELOOP' || code === 'EMLINK' ? { kind: 'outside' } : { kind: 'not-found' }
  }
  try {
    const st = fstatSync(fd)
    if (!st.isFile()) return { kind: 'not-found' }
    if (st.size > FILE_CONTENT_MAX_BYTES) return { kind: 'oversized', size: st.size }
    const buf = Buffer.alloc(st.size)
    let off = 0
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off)
      if (n <= 0) break
      off += n
    }
    const data = buf.subarray(0, off)
    if (hasNul(data)) return { kind: 'binary' }
    return {
      kind: 'ok',
      content: new TextDecoder('utf-8', { fatal: false }).decode(data),
      size: st.size,
    }
  } finally {
    closeSync(fd)
  }
}

/**
 * One side of a task file for the rendered diff. Multi-repo tasks select the
 * repo by canonical label (same labels the diff markers / structural prefixes
 * carry); single-repo tasks may omit `repo`.
 */
export async function getTaskFileContent(
  db: DbClient,
  taskId: string,
  q: { path: string; side: 'base' | 'worktree'; basePath?: string; repo?: string },
  hooks?: ContainedFileHooks,
): Promise<FileContentResult> {
  if (q.path === '') {
    throw new ValidationError('file-content-missing-path', 'path query param required')
  }
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  let worktreePath = task.worktreePath
  let baseCommit = task.baseCommit
  if (task.repoCount > 1) {
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
    const blob = await readBlobAtRef(worktreePath, baseCommit, q.basePath ?? q.path)
    if (blob === null) return { exists: false }
    if (blob.length > FILE_CONTENT_MAX_BYTES) {
      throw new DomainError('file-content-oversized', 'file exceeds the rendered-view limit', 413)
    }
    if (blob.includes('\x00')) {
      throw new DomainError('file-content-binary', 'binary file has no rendered view', 415)
    }
    return { exists: true, content: blob, size: blob.length }
  }

  const read = openContainedFile(worktreePath, q.path, hooks)
  switch (read.kind) {
    case 'ok':
      return { exists: true, content: read.content, size: read.size }
    case 'not-found':
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
