import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { SkillTreeFiles } from '../../application/skills/creationContentStore'

/** Original ZIP tree materialization, shared by creation and version replacement. */
export function writeFileSkillTree(targetDir: string, content: SkillTreeFiles): void {
  const safeRoot = resolve(targetDir) + sep
  mkdirSync(targetDir, { recursive: true })
  for (const file of content.files) {
    if (file.path === 'SKILL.md') continue
    const dst = resolve(join(targetDir, file.path))
    if (!(dst + (file.path.endsWith('/') ? sep : '')).startsWith(safeRoot)) {
      throw new Error(`unsafe path resolved outside skill dir: ${file.path}`)
    }
    mkdirSync(dirname(dst), { recursive: true })
    writeFileSync(dst, file.content)
  }
  writeFileSync(join(targetDir, 'SKILL.md'), content.mainContent, 'utf-8')
  if (!existsSync(join(targetDir, 'SKILL.md'))) throw new Error('SKILL.md was not written')
}
