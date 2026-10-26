import { createTaskClarifyDirectivePersistence } from '@/modules/task-execution/public/participants'
import { createClarifyAnswerWritePort } from './clarifyAnswerWrite'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq, exists, isNotNull, isNull, or } from 'drizzle-orm'

import type { WorkgroupTaskRoomClarifyParticipantInTx } from '@/modules/task-execution/public/commands'
import type { PersistenceTx } from '@/platform/persistence/persistenceDb'

/**
 * RFC-359 W4-D19a —— Collaboration 在工作组任务房事务里的那一半：一份实现，两个 provider 共用。
 * 调用方持有事务；这个参与者只直接访问 Collaboration 自己的表；directive 投影通过 TaskExecution public query 读取同一事务。
 */
export function createWorkgroupTaskRoomClarifyParticipantInTx(
  transaction: PersistenceTx,
): WorkgroupTaskRoomClarifyParticipantInTx {
  const clarifyDirectives = createTaskClarifyDirectivePersistence(transaction)
  return Object.freeze({
    async loadProjection(taskId) {
      const { clarifyRounds, taskQuestions } = tablesOf(transaction)
      const [open, directives] = await Promise.all([
        transaction
          .select({ askingNodeRunId: clarifyRounds.askingNodeRunId })
          .from(clarifyRounds)
          .where(
            and(
              eq(clarifyRounds.kind, 'self'),
              eq(clarifyRounds.taskId, taskId),
              // Seal and dispatch commit separately. The asking host can still
              // be unwinding after the task parks; its next snapshot must not
              // wake a new leader between the answer seal and the rerun mint.
              // Dispatch stamps the entries and mints the continuation in one
              // transaction, so that continuation takes over the park atomically.
              or(
                eq(clarifyRounds.status, 'awaiting_human'),
                and(
                  eq(clarifyRounds.status, 'answered'),
                  exists(
                    transaction
                      .select({ id: taskQuestions.id })
                      .from(taskQuestions)
                      .where(
                        and(
                          eq(taskQuestions.taskId, clarifyRounds.taskId),
                          eq(taskQuestions.originNodeRunId, clarifyRounds.intermediaryNodeRunId),
                          eq(taskQuestions.roleKind, 'self'),
                          eq(taskQuestions.confirmation, 'open'),
                          isNotNull(taskQuestions.sealedAt),
                          isNull(taskQuestions.dispatchedAt),
                        ),
                      ),
                  ),
                ),
              ),
            ),
          ),
        clarifyDirectives.listWorkgroupStops(taskId),
      ])
      return Object.freeze({
        askingNodeRunIds: Object.freeze([...new Set(open.map((round) => round.askingNodeRunId))]),
        stopDirectives: Object.freeze(directives.map((directive) => Object.freeze(directive))),
      })
    },
    async dismissOpenSelfClarifies(input) {
      const { clarifyRounds } = tablesOf(transaction)
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
        const changed = await createClarifyAnswerWritePort(transaction).transition(
          {
            roundId: round.id,
            kind: 'cancel',
            roundKind: 'self',
            taskId: input.taskId,
            expectedStatus: 'awaiting_human',
          },
          transaction,
        )
        if (changed) {
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
