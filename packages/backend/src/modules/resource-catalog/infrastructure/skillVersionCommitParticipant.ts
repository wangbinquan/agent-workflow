// RFC-353 T6（RFC-294 W4-E3）—— 技能版本提交写入面的「读 live 行」那一半。判据全在
// `domain/skillVersionCommit`；legacy 版本漏斗与融合的 tx-bound participant
// （`skillTreeVersionParticipant.ts`）共用这一份读取。

import { eq } from 'drizzle-orm'

import { skills } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

import type { SkillVersionCompositeLive } from '../domain/skillVersionCommit'

/** RFC-359 W4-D23b：legacy 版本写入路径改吃中立事务后也用这一份，同步那份随之退役。 */
export async function readSkillVersionCompositeLive(
  transaction: DatabaseTransaction,
  skillId: string,
): Promise<SkillVersionCompositeLive | null> {
  const rows = await transaction
    .select({
      id: skills.id,
      contentVersion: skills.contentVersion,
      metaRevision: skills.metaRevision,
      ownerUserId: skills.ownerUserId,
      aclRevision: skills.aclRevision,
      visibility: skills.visibility,
    })
    .from(skills)
    .where(eq(skills.id, skillId))
    .limit(1)
  return rows[0] ?? null
}
