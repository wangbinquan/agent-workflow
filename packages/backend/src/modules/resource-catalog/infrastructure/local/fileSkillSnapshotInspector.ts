import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import type { SkillSnapshotInspector } from '../../application/skills/lifecycleContentStore'
import { hashRegularFileTree } from '../legacy/skillHash'
import {
  realDirectoryChainState,
  skillFilesAbs,
  skillRootAbs,
  skillVersionAbs,
  skillVersionRelPath,
} from '../legacy/skillIdentityPaths'

/** Original on-disk snapshot and live-tree inspection, including stored references. */
export function createFileSkillSnapshotInspector(appHome: string): SkillSnapshotInspector {
  return Object.freeze({
    inspect(input) {
      const reject = (reason: string) => ({ ok: false as const, reason })
      const root = skillRootAbs(appHome, input.skillId)
      for (const version of input.versions) {
        if (version.reference !== skillVersionRelPath(input.skillId, version.version)) {
          return reject(`version ${version.version} path is not canonical`)
        }
        const dir = skillVersionAbs(appHome, input.skillId, version.version)
        if (realDirectoryChainState(root, dir) !== 'real-directory') {
          return reject(`version ${version.version} directory missing`)
        }
        const main = lstatSync(join(dir, 'SKILL.md'))
        if (!main.isFile() || main.isSymbolicLink()) {
          return reject(`version ${version.version} SKILL.md missing`)
        }
        if (hashRegularFileTree(dir) !== version.contentHash) {
          return reject(`version ${version.version} hash mismatch (tampered/corrupt)`)
        }
      }
      const current = input.versions.find((version) => version.version === input.currentVersion)!
      const live = skillFilesAbs(appHome, input.skillId)
      if (realDirectoryChainState(root, live) !== 'real-directory') {
        return reject('canonical live files directory missing')
      }
      if (hashRegularFileTree(live) !== current.contentHash) {
        return reject('canonical live tree differs from current committed version')
      }
      return { ok: true as const }
    },
  } satisfies SkillSnapshotInspector)
}
