import { and, eq, ne } from 'drizzle-orm'

import { clarifyRounds, taskNodeClarifyDirectives } from '@/db/schema'
import type { WorkgroupTaskRoomClarifyParticipantInTx } from '@/modules/task-execution/public/commands'
import type { PostgresqlCommittedEventTransaction } from '@/platform/events/committed/postgresqlPersistence'

/**
 * Collaboration's half of a reserved PostgreSQL workgroup-room transaction.
 * It never opens a nested transaction and never reads TaskExecution or
 * Resource Catalog tables.
 */
export function createPostgresqlWorkgroupTaskRoomClarifyParticipantInTx(
  transaction: PostgresqlCommittedEventTransaction,
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
