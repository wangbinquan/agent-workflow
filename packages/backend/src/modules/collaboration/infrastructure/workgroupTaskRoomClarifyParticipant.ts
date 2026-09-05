import { and, eq, ne } from 'drizzle-orm'

import { clarifyRounds, taskNodeClarifyDirectives } from '@/db/schema'
import type { WorkgroupTaskRoomClarifyParticipantInTx } from '@/modules/task-execution/public/commands'
import type { DatabaseTransaction } from '@/platform/persistence/databaseTransaction'

/**
 * RFC-359 W4-D19a —— Collaboration 在工作组任务房事务里的那一半：一份实现，两个 provider 共用。
 * 调用方持有事务；这个参与者只碰 Collaboration 自己的表，不开嵌套事务、不读 TaskExecution / Resource Catalog。
 */
export function createWorkgroupTaskRoomClarifyParticipantInTx(
  transaction: DatabaseTransaction,
): WorkgroupTaskRoomClarifyParticipantInTx {
  return Object.freeze({
    async loadProjection(taskId) {
      const [open, directives] = await Promise.all([
        transaction
          .select({ askingNodeRunId: clarifyRounds.askingNodeRunId })
          .from(clarifyRounds)
          .where(
            and(
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.taskId, taskId),
              eq(clarifyRounds.status, 'awaiting_human'),
            ),
          ),
        transaction
          .select({
            nodeId: taskNodeClarifyDirectives.nodeId,
            shardKey: taskNodeClarifyDirectives.shardKey,
            directive: taskNodeClarifyDirectives.directive,
          })
          .from(taskNodeClarifyDirectives)
          .where(
            and(
              eq(taskNodeClarifyDirectives.taskId, taskId),
              eq(taskNodeClarifyDirectives.directive, 'stop'),
              ne(taskNodeClarifyDirectives.shardKey, ''),
            ),
          ),
      ])
      return Object.freeze({
        askingNodeRunIds: Object.freeze([...new Set(open.map((round) => round.askingNodeRunId))]),
        stopDirectives: Object.freeze(directives.map((directive) => Object.freeze(directive))),
      })
    },
    async dismissOpenSelfClarifies(input) {
      const open = await transaction
        .select({
          id: clarifyRounds.id,
          nodeRunId: clarifyRounds.intermediaryNodeRunId,
          nodeId: clarifyRounds.intermediaryNodeId,
          assignmentShardKey: clarifyRounds.askingShardKey,
        })
        .from(clarifyRounds)
        .where(
          and(
            eq(clarifyRounds.kind, 'self'),
            eq(clarifyRounds.taskId, input.taskId),
            eq(clarifyRounds.status, 'awaiting_human'),
          ),
        )
      const parks: Array<{
        readonly nodeRunId: string
        readonly nodeId: string
        readonly assignmentShardKey: string | null
      }> = []
      for (const round of open) {
        const changed = await transaction
          .update(clarifyRounds)
          .set({ status: 'canceled' })
          .where(
            and(
              eq(clarifyRounds.id, round.id),
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.taskId, input.taskId),
              eq(clarifyRounds.status, 'awaiting_human'),
            ),
          )
          .returning({ id: clarifyRounds.id })
        if (changed[0] !== undefined) {
          parks.push(
            Object.freeze({
              nodeRunId: round.nodeRunId,
              nodeId: round.nodeId,
              assignmentShardKey: round.assignmentShardKey,
            }),
          )
        }
      }
      return Object.freeze({ dismissedSessions: parks.length, parks: Object.freeze(parks) })
    },
  } satisfies WorkgroupTaskRoomClarifyParticipantInTx)
}
