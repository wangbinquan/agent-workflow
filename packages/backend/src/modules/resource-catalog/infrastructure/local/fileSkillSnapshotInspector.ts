import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillSnapshotInspector } from '../../application/skills/lifecycleContentStore'
import { assertRegularFileTree } from '../legacy/skillHash'
import { hashSkillTree } from '../databaseSkillTrees'
import {
  fileSkillTreeReference,
  fileSkillReferencePath,
  readFileSkillReference,
} from './fileSkillReferences'

/** Converted local trees and synthetic database snapshots share the same byte proof. */
export function createFileSkillSnapshotInspector(
  appHome: string,
  db?: PersistenceDb,
): SkillSnapshotInspector {
  return Object.freeze({
    async inspect(input) {
      const reject = (reason: string) => ({ ok: false as const, reason })
      for (const version of input.versions) {
        const ref = await fileSkillTreeReference(appHome, db, input.skillId, version.version)
        if (ref?.kind === 'local-file') assertRegularFileTree(fileSkillReferencePath(appHome, ref))
        const tree = await readFileSkillReference(appHome, db, ref)
        if (!tree?.files.some((file) => file.path === 'SKILL.md'))
          return reject(`version ${version.version} SKILL.md missing`)
        if (hashSkillTree(tree.files) !== version.contentHash)
          return reject(`version ${version.version} hash mismatch (tampered/corrupt)`)
      }
      const current = input.versions.find((version) => version.version === input.currentVersion)
      const liveRef = await fileSkillTreeReference(appHome, db, input.skillId)
      if (liveRef?.kind === 'local-file')
        assertRegularFileTree(fileSkillReferencePath(appHome, liveRef))
      const live = await readFileSkillReference(appHome, db, liveRef)
      if (!live) return reject('live files directory missing')
      if (!current || hashSkillTree(live.files) !== current.contentHash)
        return reject('live tree differs from current committed version')
      return { ok: true as const }
    },
  } satisfies SkillSnapshotInspector)
}
