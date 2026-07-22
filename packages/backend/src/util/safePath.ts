// Defend against path traversal: every fs read/write inside a skill must land
// strictly under the skill's root directory. ValidationError on any attempt to
// escape via `..`, absolute paths, or symlinks pointing outside.

import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, normalize, resolve, sep } from 'node:path'
import { ValidationError } from '@/util/errors'

/**
 * Join `relPath` onto `root` and assert the result stays inside `root`.
 * Does NOT follow symlinks at the destination; if the file already exists and
 * is a symlink pointing outside `root`, the caller must use realpathSync.
 */
export function safeJoin(root: string, relPath: string): string {
  if (relPath.length === 0) {
    throw new ValidationError('path-empty', 'path is required')
  }
  if (isAbsolute(relPath)) {
    throw new ValidationError('path-absolute', 'path must be relative')
  }
  // RFC-054 W3-5 KNOWN_GAP fix: reject any backslash on POSIX too.
  // node:path on macOS/Linux treats `\` as a literal character, so
  // `\windows\system32` and `..\..\etc` are accepted as weird-but-
  // relative filenames. That's semantically safe on POSIX-only
  // deployments today, but it's a portability landmine for future
  // Windows binaries (where `\` IS a path separator and these would
  // be real traversals). Rejecting backslash defensively now means
  // the daemon's path-safety contract is cross-platform, and surface
  // legitimate "filenames containing backslash" attempts loudly
  // rather than silently passing them through.
  if (relPath.includes('\\')) {
    throw new ValidationError('path-backslash', 'path must not contain backslash characters')
  }
  const target = resolve(root, normalize(relPath))
  const rootResolved = resolve(root)
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (target !== rootResolved && !target.startsWith(rootPrefix)) {
    throw new ValidationError('path-traversal', 'path escapes the allowed root')
  }
  return target
}

/**
 * After resolving symlinks on an existing path, verify it still falls under
 * `root` (also realpath-resolved). Useful for read endpoints where we want to
 * follow symlinks but only within the skill.
 */
export function realpathInside(root: string, target: string): string {
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    // target doesn't exist yet — caller decides if that's an error.
    return target
  }
  const rootReal = realpathSync(root)
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  if (real !== rootReal && !real.startsWith(rootPrefix)) {
    throw new ValidationError('path-traversal', 'symlink escapes the allowed root')
  }
  return real
}

/**
 * Assert that the deepest EXISTING ancestor of `target` resolves inside `root`.
 *
 * `realpathInside` only checks a target that already exists, so it is blind to a
 * WRITE whose leaf does not exist yet but whose parent directory is a symlink
 * pointing out of `root`. `mkdirSync(dirname, {recursive:true})` and
 * `writeFileSync` both FOLLOW such a link, so the write escapes. This walks up
 * from `dirname(target)` to the first component that exists and realpath-checks
 * it — refusing before any directory is created through an escaping link.
 *
 * See RFC-170 G3-1 / design/test-guard-audit-2026-07-21 gap B5-security-8.
 */
export function assertWriteAncestorInside(root: string, target: string): void {
  const rootReal = realpathSync(root)
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  let cur = dirname(resolve(target))
  // The lexical safeJoin guarantee means `target` is under `root` textually;
  // walk up until we hit a component that actually exists on disk.
  for (;;) {
    if (existsSync(cur)) {
      const real = realpathSync(cur)
      if (real !== rootReal && !real.startsWith(rootPrefix)) {
        throw new ValidationError('path-traversal', 'path escapes the allowed root')
      }
      return
    }
    const up = dirname(cur)
    if (up === cur) return // reached the filesystem root — nothing to escape through
    cur = up
  }
}

/**
 * Resolve `target` (built via `safeJoin`) into a filesystem path that is safe to
 * WRITE or DELETE inside `root`, following the read path's symlink discipline.
 * `writeFileSync` / `unlinkSync` / `rmSync` all follow symlinks, and a skill dir
 * can contain one, so a lexical join alone lets a write/delete escape to e.g.
 * `~/.ssh/id_rsa` — with the daemon frequently running as root.
 *
 * Refuses when a parent component escapes (assertWriteAncestorInside) or when the
 * leaf itself is a symlink pointing out of `root` (realpathInside). A symlink
 * that stays inside `root` is allowed — parity with the read path, which reads
 * through contained links.
 */
export function realpathWriteInside(root: string, target: string): string {
  assertWriteAncestorInside(root, target)
  // Detect a leaf symlink with lstat (NO-follow). The old `existsSync(target)`
  // FOLLOWS the link and returns false for a DANGLING one (points at a
  // not-yet-existing file), which short-circuited the isSymbolicLink() check and
  // let a subsequent writeFileSync create the target THROUGH the escaping link
  // (RFC-170 impl-gate, Codex 2026-07-22). NOTE: check-then-write is still a
  // TOCTOU window (a concurrent actor could swap the leaf between this and the
  // write); closing it fully needs openat2/RESOLVE_BENEATH, tracked separately.
  let leafIsLink = false
  try {
    leafIsLink = lstatSync(target).isSymbolicLink()
  } catch {
    // ENOENT — the leaf does not exist at all; the ancestor walk above suffices.
  }
  if (leafIsLink) {
    if (existsSync(target)) {
      // Resolvable link: full-chain realpath + containment (unchanged).
      realpathInside(root, target)
    } else {
      // Dangling link: realpathSync would throw ENOENT, so validate the link's
      // (possibly relative) destination via the deepest-existing-ancestor walk.
      const dest = resolve(dirname(resolve(target)), readlinkSync(target))
      assertWriteAncestorInside(root, dest)
    }
  }
  return target
}
