import { existsSync } from 'node:fs'
import type { SkillVersionPresenceQueries } from '../../application/skills/contentAvailability'
import { skillVersionAbs } from '../legacy/skillIdentityPaths'

export function createFileSkillVersionPresenceQueries(
  appHome: string,
): SkillVersionPresenceQueries {
  return Object.freeze({
    exists: (reference) =>
      existsSync(skillVersionAbs(appHome, reference.id, reference.contentVersion)),
  } satisfies SkillVersionPresenceQueries)
}
