import type { FileNode } from '@agent-workflow/shared'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { sha256Hex } from '@/util/hash'
import { realpathInside } from '@/util/safePath'
import type {
  SkillVersionContentReader,
  SkillVersionTreeEntry as TreeEntry,
} from '../../application/skills/versionContentReader'
import { collectFiles } from '../legacy/skillHash'
import { skillVersionAbs } from '../legacy/skillIdentityPaths'

/** Original history reader: snapshot only, with the same absent-file semantics. */
export function createFileSkillVersionContentReader(appHome: string): SkillVersionContentReader {
  return Object.freeze({
    readSnapshot(reference) {
      const root = skillVersionAbs(appHome, reference.skillId, reference.version)
      const mainPath = join(root, 'SKILL.md')
      const main = existsSync(mainPath)
        ? readFileSync(realpathInside(root, mainPath), 'utf-8')
        : null
      return { main, files: fileTreeOf(root) }
    },
    readTree(reference) {
      return readTree(skillVersionAbs(appHome, reference.skillId, reference.version))
    },
  } satisfies SkillVersionContentReader)
}

/** Read a files/ tree into a path→entry map (binary detected by NUL byte). */
function readTree(dir: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>()
  if (!existsSync(dir)) return out
  const rels: string[] = []
  collectFiles(dir, '', rels)
  for (const rel of rels) {
    const buf = readFileSync(join(dir, rel))
    out.set(
      rel,
      buf.includes(0)
        ? { kind: 'binary', hash: sha256Hex(buf) }
        : { kind: 'text', content: buf.toString('utf-8') },
    )
  }
  return out
}

function fileTreeOf(absRoot: string): FileNode[] {
  if (!existsSync(absRoot)) return []
  const out: FileNode[] = []
  const rels: string[] = []
  // Reuse collectFiles to enumerate files; add dir nodes by inference.
  const seenDirs = new Set<string>()
  collectFiles(absRoot, '', rels)
  rels.sort()
  for (const rel of rels) {
    const parts = rel.split('/')
    let acc = ''
    for (let i = 0; i < parts.length - 1; i++) {
      acc = acc ? `${acc}/${parts[i]}` : (parts[i] as string)
      if (!seenDirs.has(acc)) {
        seenDirs.add(acc)
        out.push({ path: acc, type: 'dir' })
      }
    }
    const st = statSync(join(absRoot, rel))
    out.push({ path: rel, type: 'file', size: st.size, modifiedAt: Math.floor(st.mtimeMs) })
  }
  return out
}
