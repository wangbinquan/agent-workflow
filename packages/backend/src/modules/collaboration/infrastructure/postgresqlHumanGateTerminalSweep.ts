import { and, eq } from 'drizzle-orm'

import { clarifyRounds, nodeRuns } from '@/db/schema'
import {
  appendPostgresqlTaskNodeStatusesTx,
  withPostgresqlSerializableTaskExecution,
} from '@/modules/task-execution/infrastructure/postgresqlTaskLifecycleTransaction'
import { publishCommittedEventsAfterCommit } from '@/platform/events/committed/runtime'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import type {
  HumanGateTerminalSweepCommand,
  HumanGateTerminalSweepResult,
} from '../application/ports/humanGateTerminalSweep'

export function createPostgresqlHumanGateTerminalSweepCommand(
  db: PostgresqlDatabaseClient,
): HumanGateTerminalSweepCommand {
  return {
    async run(input) {
      const result: {
        sealedSelfRounds: number
        abandonedCrossRounds: number
        canceledRuns: { nodeRunId: string; nodeId: string }[]
      } = { sealedSelfRounds: 0, abandonedCrossRounds: 0, canceledRuns: [] }
      const now = input.now ?? Date.now()
      const eventRef = await withPostgresqlSerializableTaskExecution(db, async (tx) => {
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
        for (const round of openRounds) {
          if (round.kind === 'cross') {
            await tx
              .update(clarifyRounds)
              .set({ status: 'abandoned', abandonedAt: now })
              .where(
                and(eq(clarifyRounds.id, round.id), eq(clarifyRounds.status, 'awaiting_human')),
              )
            result.abandonedCrossRounds += 1
          } else {
            await tx
              .update(clarifyRounds)
              .set({ status: 'canceled' })
              .where(
                and(eq(clarifyRounds.id, round.id), eq(clarifyRounds.status, 'awaiting_human')),
              )
            result.sealedSelfRounds += 1
          }
          // rfc053-allow-direct-status-write -- provider terminal-sweep CAS
          const parked = await tx
            .update(nodeRuns)
            .set({ status: 'canceled', finishedAt: now, errorMessage: input.cause })
            .where(
              and(
                eq(nodeRuns.id, round.intermediaryNodeRunId),
                eq(nodeRuns.status, 'awaiting_human'),
              ),
            )
            .returning({ id: nodeRuns.id })
          if (parked.length > 0) {
            result.canceledRuns.push({
              nodeRunId: round.intermediaryNodeRunId,
              nodeId: round.intermediaryNodeId,
            })
          } else {
            await tx
              .update(nodeRuns)
              .set({ errorMessage: input.cause })
              .where(
                and(eq(nodeRuns.id, round.intermediaryNodeRunId), eq(nodeRuns.status, 'canceled')),
              )
          }
        }
        for (const status of ['awaiting_human', 'awaiting_review'] as const) {
          // rfc053-allow-direct-status-write -- provider terminal-sweep CAS
          const rows = await tx
            .update(nodeRuns)
            .set({ status: 'canceled', finishedAt: now, errorMessage: input.cause })
            .where(and(eq(nodeRuns.taskId, input.taskId), eq(nodeRuns.status, status)))
            .returning({ id: nodeRuns.id, nodeId: nodeRuns.nodeId })
          for (const row of rows) {
            result.canceledRuns.push({ nodeRunId: row.id, nodeId: row.nodeId })
          }
        }
        if (result.canceledRuns.length === 0) return null
        return await appendPostgresqlTaskNodeStatusesTx(tx, {
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
