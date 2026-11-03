// RFC-401 T5（design §10.2）—— skill 写入场景的 AtomicApply 恢复装配出口：维护作业 `intentRecovery` 与启动步骤
// `skill-operation-recovery` 共用。内容存储按工件记录的种类选取：本地文件在 `appHome` 下，数据库字节在 `skill_content_entries`。
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { Logger } from '@/util/log'

import { skillApplyRecoveryContentFor } from '../infrastructure/skillApplyContent'
import { createSkillApplyRecoveryScene } from '../infrastructure/skillApplyRecovery'

export function composeSkillApplyRecoveryScene(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly now?: () => number
  readonly log?: Pick<Logger, 'warn'>
}) {
  return createSkillApplyRecoveryScene({
    db: input.db,
    content: skillApplyRecoveryContentFor(input.db, input.appHome),
    ...(input.now === undefined ? {} : { now: input.now }),
    ...(input.log === undefined ? {} : { log: input.log }),
  })
}
