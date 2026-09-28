import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  SkillContentRoot,
  SkillCreationContentStore,
} from '../../application/skills/creationContentStore'
import { skillRootAbs } from '../legacy/skillIdentityPaths'
import { writeFileSkillTree } from './fileSkillTree'

/** Compatibility for pre-existing local compensation receipts. */
export function discardFileSkillContentRoot(root: SkillContentRoot): void {
  rmSync(root.rootRef, { recursive: true, force: true })
}

export function createFileSkillCreationContentStore(
  appHome: string,
  legacyProducer?: (filesDirectory: string) => void,
): SkillCreationContentStore {
  return Object.freeze({
    plan(skillId) {
      const rootRef = skillRootAbs(appHome, skillId)
      return { skillId, rootRef, liveRef: join(rootRef, 'files') }
    },
    initialize(plan, content) {
      mkdirSync(plan.liveRef, { recursive: true })
      if (legacyProducer) {
        legacyProducer(plan.liveRef)
      } else if (content.kind === 'main') {
        writeFileSync(join(plan.liveRef, 'SKILL.md'), content.content, 'utf-8')
      } else {
        writeFileSkillTree(plan.liveRef, content)
      }
    },
    discard: discardFileSkillContentRoot,
  } satisfies SkillCreationContentStore)
}
