// RFC-359 W4-B3 —— 任务终态时的人工门清扫（澄清轮次封存 / 作废 + 挂起 run 取消 + node-statuses committed event）：
// 一份实现，两个 provider 共用。SQLite 此前经 dbTxSync + 同步 committed-event 参与者，PG 经 SERIALIZABLE；现在同走统一写事务。

import { createHumanGatePersistenceParticipantInTx } from '@/modules/task-execution/public/participants'
import { createClarifyAnswerWritePort } from './clarifyAnswerWrite'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { and, eq } from 'drizzle-orm'

import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { appendTaskNodeStatusesCommittedEvent } from '@/modules/task-execution/infrastructure/taskLifecycleCommittedEvents'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type {
  HumanGateTerminalSweepCommand,
  HumanGateTerminalSweepResult,
} from '../application/ports/humanGateTerminalSweep'

export function createHumanGateTerminalSweepCommand(
  db: PersistenceDb,
): HumanGateTerminalSweepCommand {
  return {
    async run(input) {
      const result: {
        sealedSelfRounds: number
        abandonedCrossRounds: number
        canceledRuns: { nodeRunId: string; nodeId: string }[]
      } = { sealedSelfRounds: 0, abandonedCrossRounds: 0, canceledRuns: [] }
      const now = input.now ?? Date.now()
      const eventRef = await databaseSessionFor(db).transaction(async (tx) => {
        const { clarifyRounds } = tablesOf(tx)
        const openRounds = await tx
          .select({
            id: clarifyRounds.id,
            kind: clarifyRounds.kind,
            intermediaryNodeId: clarifyRounds.intermediaryNodeId,
            intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
          })
          .from(clarifyRounds)
          .where(
            and(eq(clarifyRounds.taskId, input.taskId), eq(clarifyRounds.status, 'awaiting_human')),
          )
        const taskHumanGate = createHumanGatePersistenceParticipantInTx(tx)
        for (const round of openRounds) {
          await createClarifyAnswerWritePort(db).transition(
            {
              roundId: round.id,
              kind: round.kind === 'cross' ? 'abandon' : 'cancel',
              expectedStatus: 'awaiting_human',
              now,
            },
            tx,
          )
          if (round.kind === 'cross') result.abandonedCrossRounds += 1
          else result.sealedSelfRounds += 1
          if (
            await taskHumanGate.cancelClarifyRun({
              runId: round.intermediaryNodeRunId,
              now,
              cause: input.cause,
            })
          ) {
            result.canceledRuns.push({
              nodeRunId: round.intermediaryNodeRunId,
              nodeId: round.intermediaryNodeId,
            })
          }
        }
        result.canceledRuns.push(
          ...(await taskHumanGate.cancelTaskGateRuns({
            taskId: input.taskId,
            now,
            cause: input.cause,
          })),
        )
        if (result.canceledRuns.length === 0) return null
        return await appendTaskNodeStatusesCommittedEvent(tx, {
          taskId: input.taskId,
          nodeChanges: result.canceledRuns.map((run) => ({
            nodeRunId: run.nodeRunId,
            nodeId: run.nodeId,
            status: 'canceled',
            cause: input.cause,
          })),
          occurredAt: now,
          identity: {
            operationRef: `terminal-sweep:${input.taskId}:${input.cause}`,
          },
        })
      })
      await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
      return result satisfies HumanGateTerminalSweepResult
    },
  }
}
