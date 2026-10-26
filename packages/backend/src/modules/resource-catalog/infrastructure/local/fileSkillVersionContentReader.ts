import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillVersionContentReader } from '../../application/skills/versionContentReader'
import {
  fileSkillTreeReference,
  readFileSkillReference,
  readFileSkillReferenceFile,
} from './fileSkillReferences'

/** Historical reads never fall back to live. */
export function createFileSkillVersionContentReader(
  appHome: string,
  db?: PersistenceDb,
): SkillVersionContentReader {
  const read = async (skillId: string, version: number) =>
    readFileSkillReference(appHome, db, await fileSkillTreeReference(appHome, db, skillId, version))
  return Object.freeze({
    async readSnapshot(reference) {
      const tree = await read(reference.skillId, reference.version)
      return {
        main: await readFileSkillReferenceFile(
          appHome,
          db,
          await fileSkillTreeReference(appHome, db, reference.skillId, reference.version),
          'SKILL.md',
        ),
        files: tree?.nodes ?? [],
      }
    },
    async readTree(reference) {
      return new Map(
        (await read(reference.skillId, reference.version))?.files.map((file) => [
          file.path,
          file.bytes,
        ]) ?? [],
      )
    },
  } satisfies SkillVersionContentReader)
}
