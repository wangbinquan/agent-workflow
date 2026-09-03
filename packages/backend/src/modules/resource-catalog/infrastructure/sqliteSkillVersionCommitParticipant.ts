// RFC-353 T6（RFC-294 W4-E3）—— SQLite 侧的技能版本提交写入面。
//
// 只干「读 live 行 / 写这两条」，判据全在 `domain/skillVersionCommit`。
// **同步**：调用方的 `dbTxSync` 回调是同步的，一旦这里返回 Promise，事务会在它兑现之前
// 就提交掉——与 memory 那条 `markFusedSync` 同一个理由（见 KE 的窄端口注释）。

import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { skills, skillVersions } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import { staleConflictError } from '@/util/errors'

import {
  planSkillVersionCommit,
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
  type SkillVersionCompositeExpectation,
  type SkillVersionCompositeLive,
} from '../domain/skillVersionCommit'
import type { SkillVersionCommitHooks, SkillVersionCommitRequest } from '../public/participants'
import { skillVersionRelPath } from './legacy/skillIdentityPaths'

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

export function sqliteSkillVersionCommitSync(
  tx: DbTxSync,
  request: SkillVersionCommitRequest,
  hooks?: SkillVersionCommitHooks<void>,
): number {
  hooks?.before?.()
  assertSkillVersionCompositeFenceSync(tx, request.skillId, request)
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
  tx.update(skills).set(plan.skillPatch).where(eq(skills.id, request.skillId)).run()
  tx.insert(skillVersions).values(plan.versionRow).run()
  hooks?.after?.(request.versionIndex)
  return request.versionIndex
}
