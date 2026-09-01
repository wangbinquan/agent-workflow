import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseSkillMarkdown } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import {
  getSkillById,
  listSkillFiles,
  skillReadRoot,
} from '@/modules/resource-catalog/infrastructure/legacy/skill'
import { realpathInside } from '@/util/safePath'
import { ValidationError } from '@/util/errors'
import type { ResourcePackageSkillTree } from '../application/package/ports'

const SKILL_MAIN = 'SKILL.md'

/** SQLite/file-system implementation of the package skill-tree reader. */
export async function readSqlitePackageSkillTree(
  db: DbClient,
  appHome: string,
  skillId: string,
): Promise<ResourcePackageSkillTree> {
  const skill = await getSkillById(db, skillId)
  if (skill === null) {
    throw new ValidationError('package-invalid', `skill '${skillId}' vanished mid-export`)
  }
  const root = skillReadRoot(skill, { appHome })

  let frontmatterExtra: Record<string, unknown> = {}
  let bodyMd = ''
  const mainPath = join(root, SKILL_MAIN)
  if (existsSync(mainPath)) {
    const raw = readFileSync(realpathInside(root, mainPath), 'utf-8')
    const parsed = parseSkillMarkdown(raw)
    frontmatterExtra = parsed.frontmatterExtra
    bodyMd = parsed.bodyMd
  }

  const files: Array<{ path: string; bytes: Uint8Array }> = []
  for (const node of await listSkillFiles(db, { appHome }, skillId)) {
    if (node.type !== 'file' || node.path === SKILL_MAIN) continue
    const abs = realpathInside(root, join(root, node.path))
    if (!existsSync(abs) || statSync(abs).isDirectory()) continue
    files.push({ path: node.path, bytes: new Uint8Array(readFileSync(abs)) })
  }
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { frontmatterExtra, bodyMd, files }
}
