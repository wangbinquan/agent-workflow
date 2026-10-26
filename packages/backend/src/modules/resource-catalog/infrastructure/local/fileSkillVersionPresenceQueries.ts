import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { SkillVersionPresenceQueries } from '../../application/skills/contentAvailability'
import { fileSkillTreeReference, fileSkillReferenceExists } from './fileSkillReferences'

export function createFileSkillVersionPresenceQueries(
  appHome: string,
  db?: PersistenceDb,
): SkillVersionPresenceQueries {
  return Object.freeze({
    exists: async (reference) =>
      fileSkillReferenceExists(
        appHome,
        db,
        await fileSkillTreeReference(appHome, db, reference.id, reference.contentVersion),
      ),
  } satisfies SkillVersionPresenceQueries)
}
