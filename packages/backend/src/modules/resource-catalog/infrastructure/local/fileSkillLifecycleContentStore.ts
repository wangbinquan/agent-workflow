import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SkillLifecycleContentStore } from '../../application/skills/lifecycleContentStore'
import { assertRegularFileTree, hashRegularFileTree } from '../legacy/skillHash'
import { skillFilesAbs, skillRootAbs, skillVersionAbs } from '../legacy/skillIdentityPaths'

/** Original legacy adoption, empty-root sweep and live reconciliation effects. */
export function createFileSkillLifecycleContentStore(appHome: string): SkillLifecycleContentStore {
  return Object.freeze({
    hasLiveMain(skillId) {
      return existsSync(join(skillFilesAbs(appHome, skillId), 'SKILL.md'))
    },
    captureInitial(skillId) {
      const filesDir = skillFilesAbs(appHome, skillId)
      if (!existsSync(join(filesDir, 'SKILL.md'))) return null
      assertRegularFileTree(filesDir)
      const versionDir = skillVersionAbs(appHome, skillId, 1)
      rmSync(versionDir, { recursive: true, force: true })
      mkdirSync(dirname(versionDir), { recursive: true })
      cpSync(filesDir, versionDir, { recursive: true })
      return hashRegularFileTree(versionDir)
    },
    isRootEmpty(skillId) {
      return dirHasNoContent(skillRootAbs(appHome, skillId))
    },
    removeRoot(skillId) {
      rmSync(skillRootAbs(appHome, skillId), { recursive: true, force: true })
    },
    restoreLiveIfMissing(skillId, version) {
      const filesDir = skillFilesAbs(appHome, skillId)
      if (existsSync(join(filesDir, 'SKILL.md'))) return
      const versionDir = skillVersionAbs(appHome, skillId, version)
      if (!existsSync(versionDir)) return
      rmSync(filesDir, { recursive: true, force: true })
      mkdirSync(dirname(filesDir), { recursive: true })
      cpSync(versionDir, filesDir, { recursive: true })
    },
  } satisfies SkillLifecycleContentStore)
}

/** Missing roots are empty; unreadable roots and any non-directory entry are not. */
function dirHasNoContent(root: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT'
  }
  for (const d of entries) {
    if (d.isDirectory()) {
      if (!dirHasNoContent(join(root, d.name))) return false
    } else {
      return false
    }
  }
  return true
}
