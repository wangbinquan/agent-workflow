// RFC-353 T6（RFC-294 W4-E3）—— 技能版本提交写入面。RFC-359 W4-D5 起一份实现，两个 provider 共用：
// participant 绑定调用方交来的统一事务句柄；判据全在 `domain/skillVersionCommit`，这里只干「读 live 行 / 写这两条」。
// 调用方把已经开好的事务交进来，版本行与它自己的状态推进原子可见。

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { skills, skillVersions } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { staleConflictError } from '@/util/errors'

import { createSkillVersionCommitParticipantInTx } from '../application/skillVersionCommit'
import {
  planSkillVersionCommit,
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
  type SkillVersionCompositeLive,
} from '../domain/skillVersionCommit'
import type {
  SkillVersionCommitHooks,
  SkillVersionCommitParticipantInTx,
  SkillVersionCommitRequest,
} from '../public/participants'
import { skillVersionRelPath } from './legacy/skillIdentityPaths'

export interface SkillVersionCommitParticipantFactory {
  inTransaction(transaction: DatabaseTransaction): SkillVersionCommitParticipantInTx
}

async function readSkillVersionCompositeLive(
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

export function composeSkillVersionCommitParticipantFactory(): SkillVersionCommitParticipantFactory {
  return Object.freeze({
    inTransaction(transaction: DatabaseTransaction) {
      return createSkillVersionCommitParticipantInTx({
        async commit(
          request: SkillVersionCommitRequest,
          hooks?: SkillVersionCommitHooks<Promise<void> | void>,
        ): Promise<number> {
          await hooks?.before?.()
          if (skillVersionCompositeFenceRequested(request)) {
            const live = await readSkillVersionCompositeLive(transaction, request.skillId)
            if (skillVersionCompositeDrifted(live, request)) {
              throw staleConflictError(
                'skill',
                request.staleMessage ??
                  `skill '${request.skillId}' changed since this operation started; reload and retry`,
              )
            }
          }
          const plan = planSkillVersionCommit({
            versionRowId: ulid(),
            skillId: request.skillId,
            versionIndex: request.versionIndex,
            contentHash: request.contentHash,
            filesPath: skillVersionRelPath(request.skillId, request.versionIndex),
            source: request.source,
            summary: request.summary,
            fusionId: request.fusionId,
            restoredFromVersion: request.restoredFromVersion,
            authorUserId: request.authorUserId,
            now: request.now,
          })
          await transaction
            .update(skills)
            .set(plan.skillPatch)
            .where(eq(skills.id, request.skillId))
          await transaction.insert(skillVersions).values(plan.versionRow)
          await hooks?.after?.(request.versionIndex)
          return request.versionIndex
        },
      })
    },
  })
}

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export const composePostgresqlSkillVersionCommitParticipantFactory =
  composeSkillVersionCommitParticipantFactory
export type PostgresqlSkillVersionCommitParticipantFactory = SkillVersionCommitParticipantFactory
