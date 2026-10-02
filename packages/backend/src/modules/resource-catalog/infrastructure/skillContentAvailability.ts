// RFC-359 W4-D15 —— 「这个 managed skill 本次启动能用吗」的判据只有一份：reservation ready、本次启动已复核，
// 且权威版本目录在盘上。PG 的 skill 内容生命周期与 SQLite 的 bootstrap 装配都用它给工作流校验器喂库存。

import type { Skill } from '@agent-workflow/shared'
import type {
  SkillContentAvailability,
  SkillVersionPresenceQueries,
} from '../application/skills/contentAvailability'
import { isSkillAvailableThisBoot } from './legacy/skillBootVerify'

export type { SkillContentAvailability } from '../application/skills/contentAvailability'

export function createSkillContentAvailability(input: {
  readonly versionPresence: SkillVersionPresenceQueries
}): SkillContentAvailability {
  return Object.freeze({
    async isAvailable(skill: Skill) {
      const availableThisBoot = () =>
        isSkillAvailableThisBoot({
          id: skill.id,
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
        })
      if (!availableThisBoot()) return false
      const exists = await input.versionPresence.exists({
        id: skill.id,
        contentVersion: skill.contentVersion,
      })
      return exists && availableThisBoot()
    },
  })
}
