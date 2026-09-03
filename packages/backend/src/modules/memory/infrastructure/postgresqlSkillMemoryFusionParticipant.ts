import { and, eq, gt, inArray } from 'drizzle-orm'

import { memories } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'

import { createMemoryMembershipParticipantInTx } from '../application/memoryMembership'
import type {
  MemoryMembershipFuseCommand,
  MemoryMembershipParticipantInTx,
  MemoryMembershipUnfuseSelector,
} from '../public/participants'
import {
  fusedProvenanceStamp,
  memoriesToMarkFused,
  orderMembershipIds,
} from '../domain/fusionMembership'

type PostgresqlMemoryTransaction = Parameters<
  Parameters<PostgresqlDatabaseClient['transaction']>[0]
>[0]

export interface PostgresqlSkillMemoryFusionParticipantFactory {
  inTransaction(transaction: PostgresqlMemoryTransaction): MemoryMembershipParticipantInTx
}

/**
 * Memory-owned half of Skill restore. The caller supplies the already-reserved
 * PostgreSQL transaction so provenance clearing and the restored Skill version
 * become visible atomically.
 */
export function composePostgresqlSkillMemoryFusionParticipantFactory(): PostgresqlSkillMemoryFusionParticipantFactory {
  return Object.freeze({
    inTransaction(
      transaction: Parameters<PostgresqlSkillMemoryFusionParticipantFactory['inTransaction']>[0],
    ) {
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
            .all()
          // 顺序同样只有一个来源：`UPDATE … RETURNING` 已经把选中规则判过了，
          // 剩下的排序走 domain 的同一个 `orderMembershipIds`，不在这里写第二个 `.sort()`。
          return Object.freeze(
            orderMembershipIds(rows.map((row: { readonly id: string }) => row.id)),
          )
        },
        async markFused(command: MemoryMembershipFuseCommand) {
          // 候选逐条判 `approved` 是**真实分支**（审批之间记忆可能被归档、被别的融合吃掉），
          // 判据与 SQLite 侧共用 `memoriesToMarkFused`，不在这里再写一遍。
          const candidates = await transaction
            .select({
              id: memories.id,
              status: memories.status,
              fusedIntoSkillId: memories.fusedIntoSkillId,
              fusedIntoSkillVersion: memories.fusedIntoSkillVersion,
            })
            .from(memories)
            .where(inArray(memories.id, [...command.memoryIds]))
            .all()
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
            .run()
          return Object.freeze(ids)
        },
      })
    },
  })
}

/**
 * RFC-353 T6 —— RFC-223 provenance 修复用的**非事务**写入面（PostgreSQL 侧）。
 * 理由同 SQLite 版：`repairProvenance` 逐条修复、没有外层事务，但写的仍是 memory 的列。
 */
export function composePostgresqlFusedSkillReassignment(db: PostgresqlDatabaseClient): {
  reassign(input: { readonly memoryId: string; readonly skillId: string }): Promise<void>
} {
  return Object.freeze({
    async reassign(input: { readonly memoryId: string; readonly skillId: string }): Promise<void> {
      await db
        .update(memories)
        .set({ fusedIntoSkillId: input.skillId })
        .where(eq(memories.id, input.memoryId))
        .run()
    },
  })
}
