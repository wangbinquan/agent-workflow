// RFC-170 — leaf hashing primitives for skill file trees. Extracted from
// skillVersion.ts so both skillVersion (version writes) and skillBootVerify (boot
// integrity re-hash) can import them WITHOUT a module cycle (skillBootVerify must
// not import skillVersion, which imports skillBootVerify for markSkillBootVerified).

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ValidationError } from '@/util/errors'

export const NUL = '\x00'

/**
 * Deterministic sha256 of a files/ tree: sorted relpath + bytes. Binary-safe
 * (hashes raw Buffer). Missing dir hashes to the empty digest. Symlinks are
 * skipped (not isFile()), so a tree with a file replaced by an escaping symlink
 * hashes DIFFERENTLY (the file's bytes vanish) — an integrity re-hash catches it.
 */
export function hashDir(dir: string): string {
  const h = createHash('sha256')
  if (!existsSync(dir)) return h.digest('hex')
  const rels: string[] = []
  collectFiles(dir, '', rels)
  rels.sort()
  for (const rel of rels) {
    h.update(rel)
    h.update(NUL)
    h.update(readFileSync(join(dir, rel)))
    h.update(NUL)
  }
  return h.digest('hex')
}

/**
 * Authority-grade hash: reject every entry that a historical `hashDir` would
 * skip but a recursive runtime copy could preserve. Keep `hashDir` unchanged so
 * old recorded hashes remain compatible; callers minting or accepting authority
 * use this stricter wrapper.
 */
export function hashRegularFileTree(dir: string): string {
  assertRegularFileTree(dir)
  return hashDir(dir)
}

export function assertRegularFileTree(root: string): void {
  const walk = (path: string): void => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      throw new ValidationError(
        'skill-identity-tree-invalid',
        `skill tree contains a symbolic link: ${path}`,
      )
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(path, name))
      return
    }
    if (!stat.isFile()) {
      throw new ValidationError(
        'skill-identity-tree-invalid',
        `skill tree contains a non-regular entry: ${path}`,
      )
    }
  }
  walk(root)
}

/**
 * No-follow structural fingerprint for identity migration. Unlike authority
 * hashing it deliberately accepts symlinks/special entries: renaming a root
 * does not traverse them, and the later per-skill verifier quarantines content
 * that is unsafe to inject. The fingerprint still detects any in-flight entry,
 * type, target, metadata, or regular-file byte change without dereferencing.
 */
export function fingerprintTree(root: string): string {
  const h = createHash('sha256')
  const walk = (path: string, rel: string): void => {
    const stat = lstatSync(path)
    const type = stat.isDirectory()
      ? 'dir'
      : stat.isFile()
        ? 'file'
        : stat.isSymbolicLink()
          ? 'symlink'
          : `special:${stat.mode}:${stat.rdev}`
    h.update(rel)
    h.update(NUL)
    h.update(type)
    h.update(NUL)
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        walk(join(path, name), rel === '.' ? name : `${rel}/${name}`)
      }
    } else if (stat.isFile()) {
      h.update(readFileSync(path))
      h.update(NUL)
    } else if (stat.isSymbolicLink()) {
      h.update(readlinkSync(path))
      h.update(NUL)
    } else {
      h.update(String(stat.size))
      h.update(NUL)
    }
  }
  walk(root, '.')
  return h.digest('hex')
}

export function collectFiles(absRoot: string, relRoot: string, out: string[]): void {
  const entries = readdirSync(join(absRoot, relRoot), { withFileTypes: true })
  for (const entry of entries) {
    const childRel = relRoot ? `${relRoot}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectFiles(absRoot, childRel, out)
    else if (entry.isFile()) out.push(childRel)
    // symlinks intentionally skipped (parity with skill.ts walkDir)
  }
}
