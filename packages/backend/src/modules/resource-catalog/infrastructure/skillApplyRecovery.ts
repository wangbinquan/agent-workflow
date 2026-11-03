// RFC-401 T5（design §10.2）—— skill 写入场景的 AtomicApply 恢复。
//
// 维护作业与启动步骤 `skill-operation-recovery` 都经 `createAtomicApplyRecovery` 收敛本场景：只接管租约已过期的记录（在途写入不动），
// prepared / applying 按工件补偿，committed 而尾部未完成前滚；终态写回的同一事务释放技能锁。内容存储按工件记录的 `contentKind`
// 选取，与写入时同一份实现。
import { and, eq } from 'drizzle-orm'

import { createAtomicApplyClaimStore } from '@/platform/atomic-apply/infrastructure/claimStore'
import { atomicApplyRecoveryClaims } from '@/platform/atomic-apply/lease'
import type { AtomicApplyRecoveryScene } from '@/platform/contracts/atomicApply'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import type { Logger } from '@/util/log'

import type { SkillContentKind } from '../application/ports/skillMutation'
import type { SkillVersionRecoveryContentStore } from '../application/skills/versionRecoveryContentStore'
import { resourcePackageSkillRecoveryDisposition } from '../domain/resourcePackageSkillRecovery'
import { markSkillBootVerified } from './legacy/skillBootVerify'
import { releaseOpLocks } from './legacy/skillOperations'
import {
  compensateSkillArtifacts,
  publicationOfSkillArtifact,
  type SkillApplyContent,
} from './skillAtomicApply'
import {
  createSkillApplyJournal,
  SKILL_APPLY_SCENE,
  skillApplyArtifactCodecs,
  type SkillApplyArtifact,
  type SkillApplyRow,
} from './skillApplyJournal'

export interface SkillApplyRecoveryContent extends SkillApplyContent {
  readonly versionRecovery: SkillVersionRecoveryContentStore
}

export interface SkillApplyRecoveryInput {
  readonly db: PersistenceDb
  /** 按工件的内容种类选存储；部署只有一种时两个键可以指向同一份。 */
  readonly content: (kind: SkillContentKind) => SkillApplyRecoveryContent
  readonly now?: () => number
  readonly log?: Pick<Logger, 'warn'>
}

async function rollForwardArtifact(
  db: PersistenceDb,
  content: SkillApplyRecoveryContent,
  artifact: SkillApplyArtifact,
): Promise<void> {
  if (artifact.kind === 'skill-delete') {
    await content.deletionContent.discard(
      content.deletionContent.plan({
        skillId: artifact.skillId,
        operationId: artifact.operationId,
        recordedBackupRef: artifact.backupJournalRef,
      }),
    )
    return
  }
  if (artifact.kind === 'skill-candidate') {
    await content.treeContent?.discardCandidate({
      skillId: artifact.skillId,
      candidateId: artifact.candidateId,
    })
    return
  }
  const { skills, skillVersions } = tablesOf(db)
  const skill = await first(
    db
      .select({ contentVersion: skills.contentVersion })
      .from(skills)
      .where(eq(skills.id, artifact.skillId))
      .limit(1),
  )
  // 已提交的 journal 不一定写下了这一版（内容不变的写入不推进版本），技能也可能已被删除或被后来的版本取代：只有当前代际才发布。
  const disposition = resourcePackageSkillRecoveryDisposition({
    currentContentVersion: skill?.contentVersion ?? null,
    artifactVersion: artifact.version,
  })
  if (disposition !== 'roll-forward-current') {
    if (disposition !== 'cleanup-superseded')
      await content.versionContent.abort(publicationOfSkillArtifact(artifact))
    else await content.versionContent.discardStage(publicationOfSkillArtifact(artifact))
    return
  }
  const row = await first(
    db
      .select({ contentHash: skillVersions.contentHash })
      .from(skillVersions)
      .where(
        and(
          eq(skillVersions.skillId, artifact.skillId),
          eq(skillVersions.versionIndex, artifact.version),
        ),
      )
      .limit(1),
  )
  if (row === undefined || row.contentHash === null)
    throw new Error(`skill-apply-version-row-missing:${artifact.skillId}:${artifact.version}`)
  const plan = content.versionRecovery.plan({
    skillId: artifact.skillId,
    operationId: artifact.publicationId,
    version: artifact.version,
    stagingReference: artifact.stagingJournalRef,
    versionReference: artifact.versionJournalRef,
  })
  await content.versionRecovery.rollForward(plan, row.contentHash)
  markSkillBootVerified(artifact.skillId)
}

export function createSkillApplyRecoveryScene(
  input: SkillApplyRecoveryInput,
): AtomicApplyRecoveryScene<typeof SKILL_APPLY_SCENE, SkillApplyRow> {
  const journal = createSkillApplyJournal(input.db)
  const claims = atomicApplyRecoveryClaims(
    journal,
    createAtomicApplyClaimStore(SKILL_APPLY_SCENE),
    {
      // 终态写回释放技能锁（op_id = journal id）。
      settle: async (tx, row) => releaseOpLocks(tx, row.id),
    },
  )
  const contentOf = (artifacts: readonly SkillApplyArtifact[]) =>
    input.content(artifacts[0]?.contentKind ?? 'local-file')
  return {
    key: SKILL_APPLY_SCENE,
    ...(input.now === undefined ? {} : { now: input.now }),
    list: () => journal.list(),
    claim: claims.claim,
    compareAndSet: claims.compareAndSet,
    async recover(row, action) {
      const artifacts = skillApplyArtifactCodecs.decode(row.preparedArtifactsJson)
      const content = contentOf(artifacts)
      if (action === 'compensate') {
        const errors = await compensateSkillArtifacts(content, artifacts, true)
        if (errors.length > 0) throw errors[0]
        return
      }
      for (const artifact of artifacts) await rollForwardArtifact(input.db, content, artifact)
    },
    errors: {
      abandoned: 'converged: crashed before commit',
      committedIncomplete: 'retryable: committed skill publication incomplete',
      retryable: (error, action) =>
        `retryable: ${action === 'compensate' ? 'compensation' : 'committed roll-forward'} incomplete: ${error instanceof Error ? error.message : String(error)}`,
    },
    warnScene(error) {
      input.log?.warn('skill-apply-converge-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    },
    warn(error, row, action) {
      input.log?.warn(
        action === 'compensate'
          ? 'skill-apply-compensation-retryable'
          : 'skill-apply-roll-forward-retryable',
        { journalId: row.id, error: error instanceof Error ? error.message : String(error) },
      )
    },
  }
}
