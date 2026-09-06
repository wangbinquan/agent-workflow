import type { ProviderNeutralDatabase } from '@/db/query'
import { createSkillZipImportParticipant as createParticipant } from '../application/skills/skillZipImport'
import type { SkillZipImportPort } from '../application/skills/ports'
import type { SkillZipImportParticipant } from '../public/participants'
import { commitSkillZipBuffer, parseSkillZipBuffer } from './legacy/skill-zip'

/** RFC-359 W4-D23c：一份 ZIP 导入适配器，两个数据库共用（底下的机器已是中立事务）。 */
export function createSkillZipImportParticipant(input: {
  readonly db: ProviderNeutralDatabase
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
  return createParticipant(Object.freeze(port))
}
