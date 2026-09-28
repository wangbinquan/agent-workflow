import type { FileNode } from '@agent-workflow/shared'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { NotFoundError, ValidationError } from '@/util/errors'
import { realpathInside, safeJoin } from '@/util/safePath'
import type {
  SkillContentReader,
  SkillContentReference,
} from '../../application/skills/contentReader'
import { skillFilesAbs, skillVersionAbs } from '../legacy/skillIdentityPaths'

/** Original RFC-170 snapshot preference, including the legacy live fallback. */
export function resolveFileSkillReadRoot(
  appHome: string,
  reference: SkillContentReference,
): string {
  const live = skillFilesAbs(appHome, reference.id)
  const snapshot = skillVersionAbs(appHome, reference.id, reference.contentVersion)
  return existsSync(snapshot) ? snapshot : live
}

/** Existing filesystem behavior; no metadata or skill-version state machine here. */
export function createFileSkillContentReader(appHome: string): SkillContentReader {
  return Object.freeze({
    readMain(reference) {
      const root = resolveFileSkillReadRoot(appHome, reference)
      const skillMdPath = join(root, 'SKILL.md')
      if (!existsSync(skillMdPath)) {
        throw new NotFoundError('skill-md-missing', `SKILL.md not found at ${skillMdPath}`)
      }
      return readFileSync(realpathInside(root, skillMdPath), 'utf-8')
    },
    listFiles(reference) {
      const root = resolveFileSkillReadRoot(appHome, reference)
      if (!existsSync(root)) return []
      return walkDir(root, '')
    },
    readFile(reference, relPath) {
      const root = resolveFileSkillReadRoot(appHome, reference)
      const abs = safeJoin(root, relPath)
      if (!existsSync(abs)) {
        throw new NotFoundError(
          'skill-file-not-found',
          `file '${relPath}' not found in skill '${reference.name}'`,
        )
      }
      const real = realpathInside(root, abs)
      if (statSync(real).isDirectory()) {
        throw new ValidationError('skill-file-is-dir', `'${relPath}' is a directory`)
      }
      return readFileSync(real, 'utf-8')
    },
  } satisfies SkillContentReader)
}

function walkDir(absRoot: string, relRoot: string): FileNode[] {
  const out: FileNode[] = []
  const entries = readdirSync(join(absRoot, relRoot), { withFileTypes: true })
  for (const entry of entries) {
    const childRel = relRoot ? `${relRoot}/${entry.name}` : entry.name
    const abs = join(absRoot, childRel)
    if (entry.isDirectory()) {
      out.push({ path: childRel, type: 'dir' })
      out.push(...walkDir(absRoot, childRel))
    } else if (entry.isFile()) {
      const st = statSync(abs)
      out.push({
        path: childRel,
        type: 'file',
        size: st.size,
        modifiedAt: Math.floor(st.mtimeMs),
      })
    }
    // Symlinks intentionally skipped in v1.
  }
  return out
}
