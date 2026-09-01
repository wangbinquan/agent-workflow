import type { DbClient } from '@/db/client'
import { createSkillZipImportParticipant } from '../application/skills/skillZipImport'
import type { SkillZipImportPort } from '../application/skills/ports'
import type { SkillZipImportParticipant } from '../public/participants'
import { commitSkillZipBuffer, parseSkillZipBuffer } from './legacy/skill-zip'

/** Explicit RFC-345 compatibility adapter; legacy mechanics stay SQLite-only. */
export function createSqliteSkillZipImportParticipant(input: {
  readonly db: DbClient
  readonly appHome: string
}): SkillZipImportParticipant {
  const port: SkillZipImportPort = {
    async parse(authority, archive) {
      const parsed = await parseSkillZipBuffer(input.db, authority, archive)
      return parsed.response
    },
    commit: (authority, archive, decisions) =>
      commitSkillZipBuffer(input.db, { appHome: input.appHome }, archive, decisions, {
        actor: authority,
      }),
  }
  return createSkillZipImportParticipant(Object.freeze(port))
}
