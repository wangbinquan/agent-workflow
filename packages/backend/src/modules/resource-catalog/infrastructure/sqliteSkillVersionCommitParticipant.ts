// RFC-353 T6（RFC-294 W4-E3）—— 技能版本复合前置条件的 SQLite **同步**栅栏。
//
// RFC-359 W4-D5 起融合提交的写入面只有一份（`skillVersionCommitParticipant.ts`，两个 provider 共用）；
// 这里只剩 legacy `skillVersion.ts` 的同步路径还要的两个读 / 判助手——它跑在 `dbTxSync` 的同步回调里，
// 拿不到 await。随 resource-catalog 的技能仓库对合一（legacy 版本写入路径退役）一起删除。

import { eq } from 'drizzle-orm'

import { skills } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { staleConflictError } from '@/util/errors'

import {
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
  type SkillVersionCompositeExpectation,
  type SkillVersionCompositeLive,
} from '../domain/skillVersionCommit'

export function readSkillVersionCompositeLiveSync(
  tx: DbTxSync,
  skillId: string,
): SkillVersionCompositeLive | null {
  return (
    tx
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
      .get() ?? null
  )
}

/**
 * 复合前置条件的 SQLite 栅栏。`legacy/skillVersion.ts#commitSkillVersionInTx` 与本文件
 * 共用它——RFC-170 那套判据从此只有 `domain/skillVersionCommit` 一处。
 */
export function assertSkillVersionCompositeFenceSync(
  tx: DbTxSync,
  skillId: string,
  expectation: SkillVersionCompositeExpectation,
): void {
  if (!skillVersionCompositeFenceRequested(expectation)) return
  if (skillVersionCompositeDrifted(readSkillVersionCompositeLiveSync(tx, skillId), expectation)) {
    throw staleConflictError(
      'skill',
      expectation.staleMessage ??
        `skill '${skillId}' changed since this operation started; reload and retry`,
    )
  }
}
