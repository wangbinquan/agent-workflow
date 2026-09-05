// RFC-353 T2 / T9（RFC-294 W4-E3）—— memory 提供给 knowledge-evolution 的成员关系 participant 与「技能吃进过哪些记忆」
// 的只读投影。RFC-359 W4-D4：一份实现，两个 provider 共用——participant 绑定到调用方交来的统一事务句柄；
// 选中与定序共用 memory domain 的同一份判据（`memoriesToMarkFused` / `orderMembershipIds` / `fusedIntoSkill`），
// 不在这里写第二遍。SQLite 融合提交的同步路径（`sqliteMemoryMembershipParticipant.ts`）随 knowledge-evolution 的
// dbTxSync 归零一起退。

import { and, eq, gt, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { memories } from '@/db/schema'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'
import { createMemoryMembershipParticipantInTx } from '../application/memoryMembership'
import { fusedIntoSkill } from '../domain/fusedProvenanceRows'
import {
  fusedProvenanceStamp,
  memoriesToMarkFused,
  orderMembershipIds,
} from '../domain/fusionMembership'
import type { FusedIntoSkillMemory } from '../public/catalog'
import type {
  MemoryMembershipFuseCommand,
  MemoryMembershipParticipantInTx,
  MemoryMembershipUnfuseSelector,
} from '../public/participants'

export interface SkillMemoryFusionParticipantFactory {
  inTransaction(transaction: DatabaseTransaction): MemoryMembershipParticipantInTx
}

/**
 * Memory-owned half of Skill fusion / restore. The caller supplies the already-open
 * transaction so provenance stamping / clearing and the Skill version become
 * visible atomically.
 */
export function composeSkillMemoryFusionParticipantFactory(): SkillMemoryFusionParticipantFactory {
  return Object.freeze({
    inTransaction(transaction: DatabaseTransaction) {
      return createMemoryMembershipParticipantInTx({
        async unfuseAboveVersion(input: MemoryMembershipUnfuseSelector) {
          // 清哪几列由 memory domain 的**同一份** stamp 决定，不在这里手写第二遍。
          const rows = await transaction
            .update(memories)
            .set(fusedProvenanceStamp(null))
            .where(
              and(
                eq(memories.status, 'fused'),
                eq(memories.fusedIntoSkillId, input.skillId),
                gt(memories.fusedIntoSkillVersion, input.aboveVersion),
              ),
            )
            .returning({ id: memories.id })
          // 顺序同样只有一个来源：`UPDATE … RETURNING` 已经把选中规则判过了，
          // 剩下的排序走 domain 的同一个 `orderMembershipIds`。
          return Object.freeze(orderMembershipIds(rows.map((row) => row.id)))
        },
        async markFused(command: MemoryMembershipFuseCommand) {
          // 候选逐条判 `approved` 是**真实分支**（审批之间记忆可能被归档、被别的融合吃掉），
          // 判据与同步路径共用 `memoriesToMarkFused`。
          const candidates = await transaction
            .select({
              id: memories.id,
              status: memories.status,
              fusedIntoSkillId: memories.fusedIntoSkillId,
              fusedIntoSkillVersion: memories.fusedIntoSkillVersion,
            })
            .from(memories)
            .where(inArray(memories.id, [...command.memoryIds]))
          const ids = memoriesToMarkFused(candidates, command.memoryIds)
          if (ids.length === 0) return Object.freeze([])
          await transaction
            .update(memories)
            .set(
              fusedProvenanceStamp({
                skillId: command.skillId,
                skillName: command.skillName,
                skillVersion: command.skillVersion,
                fusionId: command.fusionId,
                actorUserId: command.actorUserId,
                now: command.now,
              }),
            )
            .where(inArray(memories.id, [...ids]))
          return Object.freeze(ids)
        },
        async reassignFusedSkill(input: { readonly memoryId: string; readonly skillId: string }) {
          await transaction
            .update(memories)
            .set({ fusedIntoSkillId: input.skillId })
            .where(eq(memories.id, input.memoryId))
        },
      })
    },
  })
}

/** 旧名保留为装配别名，PG 装配收敛后删除。 */
export const composePostgresqlSkillMemoryFusionParticipantFactory =
  composeSkillMemoryFusionParticipantFactory
export type PostgresqlSkillMemoryFusionParticipantFactory = SkillMemoryFusionParticipantFactory

/**
 * RFC-353 T9 —— 只读投影：这个技能吃进过哪些记忆。SQL 里保留 `WHERE`（索引 `idx_memories_fused_skill_id`
 * 用得上），选中与定序的裁定权归 domain 的纯函数 `fusedIntoSkill`——无 ORDER BY 的读在两个 provider 上会漂。
 */
export async function listFusedIntoSkill(
  db: ProviderNeutralDatabase,
  skillId: string,
): Promise<FusedIntoSkillMemory[]> {
  const rows = await db
    .select({
      id: memories.id,
      title: memories.title,
      scopeType: memories.scopeType,
      scopeId: memories.scopeId,
      status: memories.status,
      fusedIntoSkillId: memories.fusedIntoSkillId,
      fusedIntoSkillVersion: memories.fusedIntoSkillVersion,
    })
    .from(memories)
    .where(eq(memories.fusedIntoSkillId, skillId))
  return fusedIntoSkill(rows, skillId).map((row) => ({
    id: row.id,
    title: row.title,
    scopeType: row.scopeType,
    scopeId: row.scopeId,
    fusedIntoSkillVersion: row.fusedIntoSkillVersion!,
  }))
}
