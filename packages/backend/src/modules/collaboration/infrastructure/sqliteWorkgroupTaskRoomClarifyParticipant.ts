import { and, eq, ne } from 'drizzle-orm'

import { clarifyRounds, taskNodeClarifyDirectives } from '@/db/schema'
import type { DbTxSync } from '@/db/txSync'
import type { WorkgroupTaskRoomClarifyParticipantInTx } from '@/modules/task-execution/public/commands'

/**
 * Collaboration's half of the SQLite workgroup-room transaction. The caller
 * owns the transaction; this participant touches only Collaboration tables.
 */
export function createSqliteWorkgroupTaskRoomClarifyParticipantInTx(
  tx: DbTxSync,
): WorkgroupTaskRoomClarifyParticipantInTx {
  return Object.freeze({
    async loadProjection(taskId) {
      const open = tx
        .select({ askingNodeRunId: clarifyRounds.askingNodeRunId })
        .from(clarifyRounds)
        .where(
          and(
            eq(clarifyRounds.kind, 'self'),
            eq(clarifyRounds.taskId, taskId),
            eq(clarifyRounds.status, 'awaiting_human'),
          ),
        )
        .all()
      const directives = tx
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
        )
        .all()
      return Object.freeze({
        askingNodeRunIds: Object.freeze([...new Set(open.map((round) => round.askingNodeRunId))]),
        stopDirectives: Object.freeze(directives.map((directive) => Object.freeze(directive))),
      })
    },
    async dismissOpenSelfClarifies(input) {
      const open = tx
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
        .all()
      const parks: Array<{
        readonly nodeRunId: string
        readonly nodeId: string
        readonly assignmentShardKey: string | null
      }> = []
      for (const round of open) {
        const changed = tx
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
          .all()
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
