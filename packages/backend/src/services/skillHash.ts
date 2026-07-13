// RFC-170 — leaf hashing primitives for skill file trees. Extracted from
// skillVersion.ts so both skillVersion (version writes) and skillBootVerify (boot
// integrity re-hash) can import them WITHOUT a module cycle (skillBootVerify must
// not import skillVersion, which imports skillBootVerify for markSkillBootVerified).

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

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

export function collectFiles(absRoot: string, relRoot: string, out: string[]): void {
  const entries = readdirSync(join(absRoot, relRoot), { withFileTypes: true })
  for (const entry of entries) {
    const childRel = relRoot ? `${relRoot}/${entry.name}` : entry.name
    if (entry.isDirectory()) collectFiles(absRoot, childRel, out)
    else if (entry.isFile()) out.push(childRel)
    // symlinks intentionally skipped (parity with skill.ts walkDir)
  }
}
