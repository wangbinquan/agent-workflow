import { and, eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRuns } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import { appendTaskNodeStatusesCommittedEventTx } from '@/modules/task-execution/public/participants'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { CommittedEventRef } from '@/platform/events/committed/types'
import type {
  HumanGateTerminalSweepCommand,
  HumanGateTerminalSweepResult,
} from '../application/ports/humanGateTerminalSweep'

export function createSqliteHumanGateTerminalSweepCommand(
  db: DbClient,
): HumanGateTerminalSweepCommand {
  return {
    async run(input) {
      const result: {
        sealedSelfRounds: number
        abandonedCrossRounds: number
        canceledRuns: { nodeRunId: string; nodeId: string }[]
      } = { sealedSelfRounds: 0, abandonedCrossRounds: 0, canceledRuns: [] }
      const now = input.now ?? Date.now()
      let eventRef: CommittedEventRef | null = null
      dbTxSync(db, (tx) => {
        const openRounds = tx
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
          .all()
        for (const round of openRounds) {
          if (round.kind === 'cross') {
            tx.update(clarifyRounds)
              .set({ status: 'abandoned', abandonedAt: now })
              .where(
                and(eq(clarifyRounds.id, round.id), eq(clarifyRounds.status, 'awaiting_human')),
              )
              .run()
            result.abandonedCrossRounds += 1
          } else {
            tx.update(clarifyRounds)
              .set({ status: 'canceled' })
              .where(
                and(eq(clarifyRounds.id, round.id), eq(clarifyRounds.status, 'awaiting_human')),
              )
              .run()
            result.sealedSelfRounds += 1
          }
          // rfc053-allow-direct-status-write -- provider terminal-sweep CAS
          const parked = tx
            .update(nodeRuns)
            .set({ status: 'canceled', finishedAt: now, errorMessage: input.cause })
            .where(
              and(
                eq(nodeRuns.id, round.intermediaryNodeRunId),
                eq(nodeRuns.status, 'awaiting_human'),
              ),
            )
            .returning({ id: nodeRuns.id })
            .all()
          if (parked.length > 0) {
            result.canceledRuns.push({
              nodeRunId: round.intermediaryNodeRunId,
              nodeId: round.intermediaryNodeId,
            })
          } else {
            tx.update(nodeRuns)
              .set({ errorMessage: input.cause })
              .where(
                and(eq(nodeRuns.id, round.intermediaryNodeRunId), eq(nodeRuns.status, 'canceled')),
              )
              .run()
          }
        }
        for (const status of ['awaiting_human', 'awaiting_review'] as const) {
          // rfc053-allow-direct-status-write -- provider terminal-sweep CAS
          const rows = tx
            .update(nodeRuns)
            .set({ status: 'canceled', finishedAt: now, errorMessage: input.cause })
            .where(and(eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.status, status)))
            .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
            .all()
          for (const row of rows) {
            result.canceledRuns.push({ nodeRunId: row.id, nodeId: row.nodeId })
          }
        }
        if (result.canceledRuns.length > 0) {
          eventRef = appendTaskNodeStatusesCommittedEventTx(tx, {
            taskId: input.taskId,
            reason: 'terminal-reconcile',
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
        }
      })
      await publishCommittedEventsAfterCommit(eventRef === null ? [] : [eventRef])
      return result satisfies HumanGateTerminalSweepResult
    },
  }
}
