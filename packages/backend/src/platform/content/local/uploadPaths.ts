// RFC-370: physical upload compatibility helpers, preserved from services/upload.
import { existsSync, lstatSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { ValidationError } from '@/util/errors'
import { realpathInside } from '@/util/safePath'

export function assertTargetDirInsideWorktree(worktreeRoot: string, targetAbs: string): void {
  let probe = targetAbs
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  // realpathInside resolves symlinks on both `worktreeRoot` and `probe` and
  // throws ValidationError('path-traversal') when probe escapes the root.
  realpathInside(worktreeRoot, probe)
}

export function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

/**
 * Existence check that does NOT follow symlinks (`lstat`, not `stat`/`existsSync`):
 * a dangling symlink, a live symlink, a file, or a dir all count as "taken".
 * RFC-107 (Codex impl-gate): the upload writer must use this — `existsSync`
 * FOLLOWS links and reports a *dangling* symlink as absent, so a committed leaf
 * symlink (e.g. `inputs/refs/x.txt -> /outside`) in an untrusted URL-cloned repo
 * would be seen as "no collision" and then `writeFileSync` would follow it and
 * create/truncate the outside target. Treating any entry as a collision makes
 * `resolveUniqueName` rename around it so the write lands on a fresh real file.
 */
export function entryExists(p: string): boolean {
  return lstatOrNull(p) !== null
}

/** Confirm `child` resolves to a path under `root`. Throws ValidationError. */
export function assertInsideWorktree(root: string, child: string): string {
  if (isAbsolute(child)) {
    throw new ValidationError(
      'upload-target-absolute',
      `targetDir must be repo-relative, got: ${child}`,
    )
  }
  const rootResolved = resolve(root)
  const target = resolve(rootResolved, normalize(child))
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (target !== rootResolved && !target.startsWith(rootPrefix)) {
    throw new ValidationError('upload-target-escape', `targetDir escapes the worktree: ${child}`)
  }
  return target
}
