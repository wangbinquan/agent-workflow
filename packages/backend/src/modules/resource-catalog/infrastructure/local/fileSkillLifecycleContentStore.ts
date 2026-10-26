import { createDatabaseSkillContent } from '../databaseSkillContent'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  fileSkillTreeReference,
  fileSkillReferencePath,
  readFileSkillReference,
} from './fileSkillReferences'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { SkillLifecycleContentStore } from '../../application/skills/lifecycleContentStore'
import { assertRegularFileTree, hashRegularFileTree } from '../legacy/skillHash'
import { skillFilesAbs, skillRootAbs, skillVersionAbs } from '../legacy/skillIdentityPaths'

/** Original legacy adoption, empty-root sweep and live reconciliation effects. */
export function createFileSkillLifecycleContentStore(
  appHome: string,
  db?: PersistenceDb,
): SkillLifecycleContentStore {
  return Object.freeze({
    async hasLiveMain(skillId) {
      const tree = await readFileSkillReference(
        appHome,
        db,
        await fileSkillTreeReference(appHome, db, skillId),
      )
      return tree?.files.some((file) => file.path === 'SKILL.md') ?? false
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
    async restoreLiveIfMissing(skillId, version) {
      const liveRef = await fileSkillTreeReference(appHome, db, skillId)
      if (!liveRef) return
      if (liveRef.kind === 'database-bytes') {
        if (!db) throw new Error('skill-entry-reader-unavailable')
        return createDatabaseSkillContent({ db }).lifecycleContent.restoreLiveIfMissing(
          skillId,
          version,
        )
      }
      const filesDir = fileSkillReferencePath(appHome, liveRef)
      if (existsSync(join(filesDir, 'SKILL.md'))) return
      const snapshot = await readFileSkillReference(
        appHome,
        db,
        await fileSkillTreeReference(appHome, db, skillId, version),
      )
      if (!snapshot) return
      rmSync(filesDir, { recursive: true, force: true })
      for (const file of snapshot.files) {
        const path = join(filesDir, file.path)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, file.bytes)
      }
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
