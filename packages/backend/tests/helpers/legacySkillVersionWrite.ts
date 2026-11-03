// RFC-401 T5 —— 构造 RFC-401 之前写下的「已提交、尾部未发布」旧 version-write 状态，供兼容执行器的用例使用。
//
// 新写入经 skill 写入场景，生产代码不再产生旧 operation；但升级来源里的旧记录（旧格式 Intent journal 记下的暂存、
// `skill_operations` 的 version-write 行）仍要被兼容执行器排空，这里按旧漏斗的顺序把它们摆出来：开 operation（带锁）→
// 暂存并固化版本快照（逐段推进 phase）→ 在一个事务里写版本行并推进到 db-committed。live 不发布。
import { ulid } from 'ulid'

import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { eq } from 'drizzle-orm'
import {
  advancePhase,
  beginOperation,
} from '@/modules/resource-catalog/infrastructure/legacy/skillOperations'
import type { StagedSkillVersion } from '@/modules/resource-catalog/infrastructure/legacy/skillVersion'
import { createFileSkillVersionContentStore } from '@/modules/resource-catalog/infrastructure/local/fileSkillVersionContentStore'
import { createSkillMutationParticipant } from '@/modules/resource-catalog/infrastructure/skillMutationParticipant'

export async function stageCommittedLegacyVersionWrite(input: {
  readonly db: PersistenceDb
  readonly appHome: string
  readonly skillId: string
  readonly mainContent: string
  readonly authorUserId: string | null
}): Promise<StagedSkillVersion> {
  const { db, skillId } = input
  const { skills } = tablesOf(db)
  const skill = await first(db.select().from(skills).where(eq(skills.id, skillId)))
  if (skill === undefined) throw new Error(`legacy fixture skill '${skillId}' missing`)
  const version = skill.contentVersion + 1
  const content = createFileSkillVersionContentStore(input.appHome, undefined, db)
  const publishId = ulid()
  const plan = content.plan({ skillId, version, publicationId: publishId })
  const session = databaseSessionFor(db)
  const opId = await session.transaction((tx) =>
    beginOperation(tx, {
      skillId,
      kind: 'version-write',
      targetVersion: version,
      stagingPath: plan.stagingJournalRef,
      candidatePath: plan.versionJournalRef,
      preconditionJson: JSON.stringify({ skillId }),
    }),
  )
  const staged = await content.stage(
    plan,
    { kind: 'write-main', content: Buffer.from(input.mainContent) },
    false,
  )
  await session.transaction((tx) => advancePhase(tx, opId, 'fs-staged'))
  await content.captureVersion(plan)
  await session.transaction((tx) => advancePhase(tx, opId, 'fs-versioned'))
  await session.transaction(async (tx) => {
    await createSkillMutationParticipant(tx).version({
      skillId,
      versionIndex: version,
      contentKind: 'local-file',
      contentHash: staged.contentHash,
      fence: {},
      source: 'editor',
      summary: null,
      fusionId: null,
      restoredFromVersion: null,
      authorUserId: input.authorUserId,
      advance: 'always',
      now: Date.now(),
    })
    await advancePhase(tx, opId, 'db-committed')
  })
  return {
    contentKind: 'local-file',
    skillId,
    skillName: skill.name,
    opId,
    publishId,
    newVersion: version,
    newHash: staged.contentHash,
    filesDir: plan.liveRef,
    versionDir: plan.versionRef,
    stagingDir: plan.stagingRef,
    noop: null,
  }
}
