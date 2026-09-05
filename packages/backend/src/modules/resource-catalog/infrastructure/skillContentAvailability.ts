// RFC-359 W4-D15 —— 「这个 managed skill 本次启动能用吗」的判据只有一份：reservation ready、本次启动已复核，
// 且权威版本目录在盘上。PG 的 skill 内容生命周期与 SQLite 的 bootstrap 装配都用它给工作流校验器喂库存。

import { existsSync } from 'node:fs'
import type { Skill } from '@agent-workflow/shared'

import { isSkillAvailableThisBoot } from './legacy/skillBootVerify'
import { skillVersionAbs } from './legacy/skillIdentityPaths'

export interface SkillContentAvailability {
  isAvailable(skill: Skill): Promise<boolean>
}

export function createSkillContentAvailability(input: {
  readonly appHome: string
}): SkillContentAvailability {
  return Object.freeze({
    async isAvailable(skill: Skill) {
      return (
        isSkillAvailableThisBoot({
          id: skill.id,
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
        }) && existsSync(skillVersionAbs(input.appHome, skill.id, skill.contentVersion))
      )
    },
  })
}
