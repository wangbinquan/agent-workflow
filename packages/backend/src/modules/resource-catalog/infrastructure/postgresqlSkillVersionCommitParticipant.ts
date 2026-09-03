// RFC-353 T6（RFC-294 W4-E3）—— PostgreSQL 侧的技能版本提交写入面。
//
// 与 SQLite 版同判据（`domain/skillVersionCommit`），差别只有「事务是 async 的」。
// 调用方把已经开好的事务交进来，版本行与它自己的状态推进原子可见。

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { skills, skillVersions } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
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

type PostgresqlSkillTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

export interface PostgresqlSkillVersionCommitParticipantFactory {
  inTransaction(transaction: PostgresqlSkillTransaction): SkillVersionCommitParticipantInTx
}

export function composePostgresqlSkillVersionCommitParticipantFactory(): PostgresqlSkillVersionCommitParticipantFactory {
  return Object.freeze({
    inTransaction(
      transaction: Parameters<PostgresqlSkillVersionCommitParticipantFactory['inTransaction']>[0],
    ) {
      return createSkillVersionCommitParticipantInTx({
        async commit(
          request: SkillVersionCommitRequest,
          hooks?: SkillVersionCommitHooks<Promise<void> | void>,
        ): Promise<number> {
          await hooks?.before?.()
          if (skillVersionCompositeFenceRequested(request)) {
            const live =
              ((await transaction
                .select({
                  id: skills.id,
                  contentVersion: skills.contentVersion,
                  metaRevision: skills.metaRevision,
                  ownerUserId: skills.ownerUserId,
                  aclRevision: skills.aclRevision,
                  visibility: skills.visibility,
                })
                .from(skills)
                .where(eq(skills.id, request.skillId))
                .get()) as SkillVersionCompositeLive | undefined) ?? null
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
            .run()
          await transaction.insert(skillVersions).values(plan.versionRow).run()
          await hooks?.after?.(request.versionIndex)
          return request.versionIndex
        },
      })
    },
  })
}
