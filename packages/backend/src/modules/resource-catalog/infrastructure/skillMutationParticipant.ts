// RFC-401 T5 —— skill 的唯一写入参与者（design §10.2）。
//
// `skills` / `skill_versions` 行只由这里写，全部 SQL 在调用方传入的事务上执行。规则只有一份：
//   新建：同一 owner 下重名 → 409 `skill-name-in-use`「skill 'x' already exists」（唯一约束冲突归一为同一错误）；ready 行与 v1
//         版本行同一事务写入，没有 `reserving` 中间态。
//   推进版本：hooks.before → 六字段复合前置条件（不符 → `resource-operation-stale`）→ 版本号必须是 contentVersion + 1 → 内容摘要与
//         当前版本相同且 description 不变 → already-current（不写任何行）→ CAS 写 skills（description 变化时 metaRevision + 1）
//         → 插入版本行 → hooks.after。
//   删除：复合前置条件 → 事务内复查 agent 引用（仍被引用 → `SkillDeleteReferencedError`）→ 删除行（版本行级联）。

import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { engineOf } from '@/platform/persistence/databaseTransaction'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'
import { first } from '@/platform/persistence/queryHelpers'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { isOwnerNameUniqueViolation, ownerScopedNameWhere } from './ownerScopedName'
import { ConflictError, staleConflictError } from '@/util/errors'

import type {
  SkillCreateMutation,
  SkillDeleteMutation,
  SkillMutationParticipant,
  SkillVersionMutation,
  SkillVersionMutationResult,
} from '../application/ports/skillMutation'
import { initialPrivateResourceAcl } from '../application/resourceDefaults'
import {
  planSkillVersionCommit,
  skillVersionCompositeDrifted,
  skillVersionCompositeFenceRequested,
} from '../domain/skillVersionCommit'
import { capturedSkillTreeColumns } from './databaseSkillTrees'
import { skillFilesRel, skillVersionRelPath } from './legacy/skillIdentityPaths'
import {
  findAgentsUsingManagedSkill,
  type SkillReferencingAgentRow,
} from './legacy/skillReferenceGuard'
import { createAgentSkillReferenceLookup } from './referenceLookup'
import { readSkillVersionCompositeLive } from './skillVersionCommitParticipant'

/** 删除提交前仍被 agent 引用；场景在补偿之后按调用者可见性披露引用并转成 409 `skill-in-use`。 */
export class SkillDeleteReferencedError extends Error {
  constructor(public readonly refs: SkillReferencingAgentRow[]) {
    super(`managed skill gained ${refs.length} agent reference(s) before delete commit`)
    this.name = 'SkillDeleteReferencedError'
  }
}

/** owner + name 唯一冲突：PG 给约束名 `skills_owner_name_unique`，SQLite 给索引名或列清单。 */
function isOwnerNameConflict(tx: PersistenceTx, error: unknown): boolean {
  const target = engineOf(tx).uniqueViolationTarget(error)
  return target !== undefined && /skills[._](?:owner|name)/i.test(target)
}

export function skillNameInUse(name: string): ConflictError {
  return new ConflictError('skill-name-in-use', `skill '${name}' already exists`)
}

function staleSkill(skillId: string, message?: string): Error {
  return staleConflictError(
    'skill',
    message ?? `skill '${skillId}' changed since this operation started; reload and retry`,
  )
}

export function createSkillMutationParticipant(tx: PersistenceTx): SkillMutationParticipant {
  return Object.freeze({
    async create(input: SkillCreateMutation): Promise<void> {
      const { skills, skillVersions } = tablesOf(tx)
      const collision = await first(
        tx
          .select({ id: skills.id })
          .from(skills)
          .where(
            ownerScopedNameWhere(skills.ownerUserId, skills.name, input.ownerUserId, input.name),
          )
          .limit(1),
      )
      if (collision !== undefined) throw skillNameInUse(input.name)
      try {
        await insertOne(tx, skills, {
          id: input.id,
          name: input.name,
          description: input.description,
          ...capturedSkillTreeColumns(
            input.contentKind,
            input.id,
            'live',
            input.livePath ?? skillFilesRel(input.id),
          ),
          ...initialPrivateResourceAcl(input.ownerUserId),
          contentVersion: 1,
          metaRevision: 0,
          reservationState: 'ready',
          versionState: 'snapshot-authoritative',
          createdAt: input.now,
          updatedAt: input.now,
        })
      } catch (error) {
        // 两笔并发新建都越过上面的检查时，后一笔撞 owner + 名称唯一索引：归一为同一个 409，不让驱动错误冒成 500。
        if (
          isOwnerNameUniqueViolation(error, 'skills', 'skills_owner_name_unique') ||
          isOwnerNameConflict(tx, error)
        )
          throw skillNameInUse(input.name)
        throw error
      }
      await insertOne(tx, skillVersions, {
        id: ulid(),
        skillId: input.id,
        versionIndex: 1,
        ...capturedSkillTreeColumns(
          input.contentKind,
          input.id,
          'version:1',
          input.versionPath ?? skillVersionRelPath(input.id, 1),
        ),
        source: 'initial',
        summary: 'Initial version',
        fusionId: null,
        restoredFromVersion: null,
        authorUserId: input.authorUserId,
        contentHash: input.contentHash,
        createdAt: input.now,
      })
    },

    async version(input: SkillVersionMutation): Promise<SkillVersionMutationResult> {
      await input.hooks?.before?.()
      const live = await readSkillVersionCompositeLive(tx, input.skillId)
      if (
        live === null ||
        (skillVersionCompositeFenceRequested(input.fence) &&
          skillVersionCompositeDrifted(live, input.fence))
      )
        throw staleSkill(input.skillId, input.fence.staleMessage)
      if (input.versionIndex !== live.contentVersion + 1) throw staleSkill(input.skillId)
      const { skills, skillVersions } = tablesOf(tx)
      const row = await first(
        tx
          .select({ description: skills.description, updatedAt: skills.updatedAt })
          .from(skills)
          .where(eq(skills.id, input.skillId))
          .limit(1),
      )
      if (row === undefined) throw staleSkill(input.skillId)
      const descriptionChanged =
        input.description !== undefined && input.description !== row.description
      if ((input.advance ?? 'on-change') === 'on-change' && !descriptionChanged) {
        const current = await first(
          tx
            .select({ contentHash: skillVersions.contentHash })
            .from(skillVersions)
            .where(
              and(
                eq(skillVersions.skillId, input.skillId),
                eq(skillVersions.versionIndex, live.contentVersion),
              ),
            )
            .limit(1),
        )
        if (
          current !== undefined &&
          input.contentHash !== null &&
          current.contentHash === input.contentHash
        )
          return Object.freeze({
            outcome: 'already-current',
            versionIndex: live.contentVersion,
            metaRevision: live.metaRevision,
          })
      }
      const metaRevision = descriptionChanged ? live.metaRevision + 1 : live.metaRevision
      // 同一毫秒里的连续写入也要让 updatedAt 单调前进（Intent 与资源包此前各自如此）。
      const now = Math.max(input.now, row.updatedAt + 1)
      const plan = planSkillVersionCommit({
        versionRowId: ulid(),
        skillId: input.skillId,
        versionIndex: input.versionIndex,
        contentHash: input.contentHash,
        filesPath: input.versionPath ?? skillVersionRelPath(input.skillId, input.versionIndex),
        source: input.source,
        summary: input.summary,
        fusionId: input.fusionId,
        restoredFromVersion: input.restoredFromVersion,
        authorUserId: input.authorUserId,
        now,
        ...(input.description === undefined ? {} : { setDescription: input.description }),
      })
      const changed = await first(
        tx
          .update(skills)
          .set({
            ...plan.skillPatch,
            metaRevision,
            ...capturedSkillTreeColumns(
              input.contentKind,
              input.skillId,
              'live',
              input.livePath ?? skillFilesRel(input.skillId),
            ),
          })
          .where(
            and(
              eq(skills.id, input.skillId),
              eq(skills.contentVersion, live.contentVersion),
              eq(skills.metaRevision, live.metaRevision),
              eq(skills.aclRevision, live.aclRevision),
            ),
          )
          .returning({ id: skills.id }),
      )
      if (changed === undefined) throw staleSkill(input.skillId, input.fence.staleMessage)
      const { filesPath, ...versionRow } = plan.versionRow
      try {
        await insertOne(tx, skillVersions, {
          ...versionRow,
          ...capturedSkillTreeColumns(
            input.contentKind,
            input.skillId,
            `version:${input.versionIndex}`,
            filesPath,
          ),
        })
      } catch (error) {
        // 上面的 CAS 已推进 contentVersion，同一版本号的行只可能是并发写入留下的：按 stale 退回。
        if (engineOf(tx).uniqueViolationTarget(error) !== undefined)
          throw staleSkill(input.skillId, input.fence.staleMessage)
        throw error
      }
      await input.hooks?.after?.(input.versionIndex)
      return Object.freeze({
        outcome: 'committed',
        versionIndex: input.versionIndex,
        metaRevision,
        versionRowId: versionRow.id,
      })
    },

    async delete(input: SkillDeleteMutation): Promise<void> {
      if (input.fence !== undefined && skillVersionCompositeFenceRequested(input.fence)) {
        const live = await readSkillVersionCompositeLive(tx, input.skillId)
        if (skillVersionCompositeDrifted(live, input.fence))
          throw staleSkill(input.skillId, input.fence.staleMessage)
      }
      const refs = await findAgentsUsingManagedSkill(
        createAgentSkillReferenceLookup(tx),
        input.skillId,
      )
      if (refs.length > 0) throw new SkillDeleteReferencedError(refs)
      const { skills } = tablesOf(tx)
      await tx.delete(skills).where(eq(skills.id, input.skillId))
    },
  } satisfies SkillMutationParticipant)
}
