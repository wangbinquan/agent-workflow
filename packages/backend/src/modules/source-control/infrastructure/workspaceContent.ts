// RFC-363 — Source Control workspace content mechanism.
//
// List direct children with complete pagination and read bounded raw bytes.
// Both preserve the established path and symlink behavior, including
// path traversal + symlinks pointing outside the worktree root.
//
// Kept dependency-light (no DB, no Hono) so unit tests can drive these
// against a real tmpdir without the rest of the daemon spinning up.

import type { Dirent } from 'node:fs'
import { lstat, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

import { WORKTREE_FILE_MAX_BYTES, type WorktreeTreeEntry } from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'
import { ulid } from 'ulid'
import type { WorkspaceContentParticipant } from '../public/participants'
import type {
  AuthorizedWorkspaceSnapshotRef,
  WorkspaceListRequest,
  WorkspaceReadRequest,
  WorkspaceEntryPage,
  BoundedWorkspaceContent,
} from '../public/types'
import { decodeRepositoryLaunchRef } from '../domain/repositoryLaunchRef'

/**
 * Resolve `relPath` against `worktreePath` and assert the result is still
 * inside the worktree. Empty `relPath` resolves to the worktree root itself
 * (used by the tree-list endpoint for the root directory). Mirrors the
 * lexical containment check in `util/safePath.ts` but tolerates the empty
 * path that `safeJoin` rejects.
 */
function resolveInsideWorktree(worktreePath: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new ValidationError('worktree-path-absolute', 'path must be relative')
  }
  // Reject backslash on POSIX too (cross-platform safety, matches safePath.ts).
  if (relPath.includes('\\')) {
    throw new ValidationError('worktree-path-backslash', 'path must not contain backslash')
  }
  const root = resolve(worktreePath)
  const target = relPath.length === 0 ? root : resolve(root, normalize(relPath))
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new ValidationError('worktree-path-traversal', 'path escapes the worktree root')
  }
  return target
}

/**
 * After existence check, verify the resolved target's realpath still falls
 * under the worktree (catches symlinks pointing outside). Returns true when
 * the entry is safe to expose; false when it should be skipped silently.
 */
async function isInsideAfterRealpath(rootReal: string, target: string): Promise<boolean> {
  try {
    const real = await realpath(target)
    const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
    return real === rootReal || real.startsWith(rootPrefix)
  } catch {
    return false
  }
}

function compareEntries(a: WorktreeTreeEntry, b: WorktreeTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return (
    a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )
}

/**
 * List the direct children of `relPath` inside `worktreePath`.
 *
 * - Empty `relPath` = worktree root.
 * - `.git` (file or directory, including submodule gitlink files) is always
 *   filtered.
 * - Symlinks whose realpath escapes the worktree are silently skipped (not
 *   surfaced as errors — repos often contain such links and the listing
 *   should remain stable).
 * - Enumerate and sort the complete directory before slicing the requested page.
 *
 * Throws:
 *   - NotFoundError('worktree-dir-not-found') — relPath does not exist.
 *   - NotFoundError('worktree-dir-not-a-directory') — relPath exists but is
 *     a regular file or other non-dir entry.
 *   - ValidationError — relPath malformed or escapes root.
 */
async function listWorkspaceDirectory(
  worktreePath: string,
  request: WorkspaceListRequest,
): Promise<WorkspaceEntryPage> {
  assertBound(request.page.offset, false)
  assertBound(request.maxEntries, true)
  const relPath = request.relativeDirectory
  const target = resolveInsideWorktree(worktreePath, relPath)
  let st
  try {
    st = await stat(target)
  } catch {
    throw new NotFoundError(
      'worktree-dir-not-found',
      `directory '${relPath}' not found in worktree`,
    )
  }
  if (!st.isDirectory()) {
    throw new NotFoundError('worktree-dir-not-a-directory', `path '${relPath}' is not a directory`)
  }

  const rootReal = await realpath(resolve(worktreePath))

  let raw: Dirent[]
  try {
    raw = (await readdir(target, { withFileTypes: true, encoding: 'utf8' })) as Dirent[]
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENAMETOOLONG') {
      throw new ValidationError('worktree-path-too-long', 'path is too long')
    }
    throw err
  }

  const entries: WorktreeTreeEntry[] = []
  for (const dirent of raw) {
    if (dirent.name === '.git') continue
    const childAbs = resolve(target, dirent.name)
    // Resolve symlinks defensively; non-symlink entries are cheap (realpath
    // on a regular path resolves to itself).
    const safe = await isInsideAfterRealpath(rootReal, childAbs)
    if (!safe) continue

    let kind: 'file' | 'directory'
    let size: number | null
    if (dirent.isSymbolicLink()) {
      // Determine the symlink target's effective type via stat (follows links).
      try {
        const targetStat = await stat(childAbs)
        if (targetStat.isDirectory()) {
          kind = 'directory'
          size = null
        } else if (targetStat.isFile()) {
          kind = 'file'
          size = targetStat.size
        } else {
          continue
        }
      } catch {
        continue
      }
    } else if (dirent.isDirectory()) {
      kind = 'directory'
      size = null
    } else if (dirent.isFile()) {
      try {
        const fst = await lstat(childAbs)
        size = fst.size
      } catch {
        size = 0
      }
      kind = 'file'
    } else {
      // socket / fifo / blockdev / chardev — skip.
      continue
    }
    entries.push({ name: dirent.name, kind, size })
  }

  entries.sort(compareEntries)
  const end = Math.min(entries.length, request.page.offset + request.maxEntries)
  return {
    entries: entries.slice(request.page.offset, end),
    nextOffset: end < entries.length ? end : null,
    truncated: false,
  }
}

/**
 * Read actual bytes without UTF-8 decoding. Large files remain readable in
 * bounded pages; the Task HTTP projection preserves its original display cap.
 *
 * Throws:
 *   - NotFoundError('worktree-file-not-found') — file does not exist.
 *   - NotFoundError('worktree-file-not-a-file') — path exists but is not a
 *     regular file.
 *   - ValidationError — relPath empty / malformed / escapes root, or symlink
 *     target escapes root.
 */
async function readWorkspaceBytes(
  worktreePath: string,
  request: WorkspaceReadRequest,
): Promise<BoundedWorkspaceContent> {
  assertBound(request.offset, false)
  assertBound(request.maxBytes, false)
  const relPath = request.relativeFile
  if (relPath.length === 0) {
    throw new ValidationError('worktree-file-missing-path', 'file path is required')
  }
  const target = resolveInsideWorktree(worktreePath, relPath)

  let st
  try {
    st = await stat(target)
  } catch {
    throw new NotFoundError('worktree-file-not-found', `file '${relPath}' not found`)
  }
  if (!st.isFile()) {
    throw new NotFoundError('worktree-file-not-a-file', `path '${relPath}' is not a regular file`)
  }

  // Existence confirmed — now make sure symlinks didn't redirect us out of
  // the worktree. Done after stat so a non-existent path surfaces as 404
  // rather than the more confusing "symlink escapes" validation error.
  const rootReal = await realpath(resolve(worktreePath))
  const safe = await isInsideAfterRealpath(rootReal, target)
  if (!safe) {
    throw new ValidationError(
      'worktree-file-symlink-escapes',
      `symlink '${relPath}' resolves outside the worktree`,
    )
  }

  // A zero-byte observation lets the existing display projection preserve its
  // oversized short circuit without opening content it previously never read.
  if (request.maxBytes === 0)
    return {
      encoding: 'base64',
      content: '',
      size: st.size,
      offset: request.offset,
      nextOffset: request.offset < st.size ? request.offset : null,
      oversized: st.size > WORKTREE_FILE_MAX_BYTES,
    }
  const file = await open(target, 'r')
  try {
    const bytes = Buffer.alloc(Math.min(request.maxBytes, Math.max(0, st.size - request.offset)))
    let count = 0
    while (count < bytes.length) {
      const read = await file.read(bytes, count, bytes.length - count, request.offset + count)
      if (read.bytesRead === 0) break
      count += read.bytesRead
    }
    const next = request.offset + count
    return {
      encoding: 'base64',
      content: bytes.subarray(0, count).toString('base64'),
      size: st.size,
      offset: request.offset,
      nextOffset: count > 0 && next < st.size ? next : null,
      oversized: st.size > WORKTREE_FILE_MAX_BYTES,
    }
  } finally {
    await file.close()
  }
}

function assertBound(value: number, positive: boolean) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0))
    throw new ValidationError(
      'workspace-read-bounds-invalid',
      'workspace bounds must be finite integers',
    )
}

/**
 * Root-only binding from the current Task-owned workspace lookup. The authorized
 * reference is valid only in this query scope; it is not a durable preparation ref.
 * No Task row/database or root path crosses the public participant methods.
 */
export function createWorkspaceContentScope(worktreePath: string) {
  const snapshot: AuthorizedWorkspaceSnapshotRef = decodeRepositoryLaunchRef(
    'workspace',
    `sc:workspace:v1:${ulid()}`,
  )
  let live = true
  function assertScope(reference: AuthorizedWorkspaceSnapshotRef) {
    if (!live || reference !== snapshot)
      throw new Error('workspace-content-scope-ended-or-mismatched')
  }
  const participant = Object.freeze<WorkspaceContentParticipant>({
    async list(reference, request) {
      assertScope(reference)
      const result = await listWorkspaceDirectory(worktreePath, request)
      assertScope(reference)
      return result
    },
    async read(reference, request) {
      assertScope(reference)
      const result = await readWorkspaceBytes(worktreePath, request)
      assertScope(reference)
      return result
    },
  })
  return Object.freeze({
    snapshot,
    participant,
    close: () => {
      live = false
    },
  })
}
