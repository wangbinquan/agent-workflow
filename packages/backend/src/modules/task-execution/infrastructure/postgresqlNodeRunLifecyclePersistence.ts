import {
  allowedFromStatusesForEvent,
  isTerminalNodeRunStatus,
  nextNodeRunStatus,
  type NodeRunStatus,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import { nodeRuns, tasks } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  NodeRunLifecyclePersistence,
  NodeRunMintInput,
} from '../application/ports/nodeRunLifecyclePersistence'
import type { NodeRunLifecycleParticipantInTx } from '../public/commands'
import {
  appendPostgresqlTaskNodeStatusesTx,
  assertPostgresqlTaskOwnerlessTx,
  assertPostgresqlTaskOwnerTx,
  type PostgresqlTaskExecutionTransaction,
  withPostgresqlSerializableTaskExecution,
} from './postgresqlTaskLifecycleTransaction'
import { createPostgresqlNodeRunMintParticipantInTx } from './postgresqlNodeRunMintParticipant'

const SOURCE_TERMINATION_BLOCKED_NODE_STATUSES = new Set(
  allowedFromStatusesForEvent({ kind: 'mark-canceled' }),
)

async function fence(
  tx: PostgresqlTaskExecutionTransaction,
  taskId: string,
  executionContext: NodeRunMintInput['executionContext'],
  now: number,
): Promise<void> {
  if (executionContext === undefined) {
    await assertPostgresqlTaskOwnerlessTx(tx, taskId)
    return
  }
  if (executionContext.token.taskId !== taskId) {
    throw new ConflictError(
      'task-execution-context-mismatch',
      `execution context for '${executionContext.token.taskId}' cannot mutate task '${taskId}'`,
    )
  }
  await assertPostgresqlTaskOwnerTx(tx, executionContext.token, now)
}

async function rowForUpdate(
  tx: PostgresqlTaskExecutionTransaction,
  nodeRunId: string,
): Promise<
  Readonly<{
    status: NodeRunStatus
    taskId: string
    sourceTerminationFence: 'closed' | 'merged' | null
  }>
> {
  const rows = await tx
    .select({
      status: nodeRuns.status,
      taskId: nodeRuns.taskId,
      sourceTerminationFence: tasks.sourceTerminationFence,
    })
    .from(nodeRuns)
    .innerJoin(tasks, eq(tasks.id, nodeRuns.taskId))
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) {
    throw new NotFoundError('node-run-not-found', `node_run ${nodeRunId} not found`)
  }
  return { ...row, status: row.status as NodeRunStatus }
}

function assertSourceTerminationAdmission(input: {
  readonly taskId: string
  readonly fence: 'closed' | 'merged' | null
  readonly to: NodeRunStatus
}): void {
  if (input.fence === null || !SOURCE_TERMINATION_BLOCKED_NODE_STATUSES.has(input.to)) {
    return
  }
  throw new ConflictError(
    input.fence === 'closed' ? 'task-source-terminal-closed' : 'task-source-terminal-merged',
    `task ${input.taskId} is fenced by an MR/PR ${input.fence} event; cannot move a node run to ${input.to}`,
  )
}

/**
 * Bind TaskExecution's exact node-state CAS to an already-reserved
 * PostgreSQL transaction.  The caller owns transaction admission; this
 * participant owns status legality, source-terminal fencing and the CAS.
 */
export function createPostgresqlNodeRunLifecycleParticipantInTx(
  tx: PostgresqlTaskExecutionTransaction,
): NodeRunLifecycleParticipantInTx {
  return Object.freeze({
    async set(input: Parameters<NodeRunLifecycleParticipantInTx['set']>[0]) {
      const row = await rowForUpdate(tx, input.nodeRunId)
      assertSourceTerminationAdmission({
        taskId: row.taskId,
        fence: row.sourceTerminationFence,
        to: input.to,
      })
      if (isTerminalNodeRunStatus(row.status) && input.allowTerminal !== true) {
        throw new ConflictError(
          'illegal-node-run-transition',
          `node_run ${input.nodeRunId} is terminal ('${row.status}'); refuse to overwrite`,
        )
      }
      if (!input.allowedFrom.includes(row.status)) {
        throw new ConflictError(
          'illegal-node-run-transition',
          `node_run ${input.nodeRunId} status='${row.status}' not in allowedFrom`,
        )
      }
      const updated = await tx
        .update(nodeRuns)
        .set({ status: input.to, ...(input.extra ?? {}) })
        .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.status, row.status)))
        .returning({ id: nodeRuns.id })
      if (updated[0] === undefined) {
        throw new ConflictError(
          'concurrent-node-run-transition',
          `node_run ${input.nodeRunId} status changed concurrently`,
        )
      }
      return { from: row.status, to: input.to }
    },
    async completeClarifyNode(
      input: Parameters<NodeRunLifecycleParticipantInTx['completeClarifyNode']>[0],
    ) {
      const row = await rowForUpdate(tx, input.nodeRunId)
      if (row.taskId !== input.taskId) {
        throw new ConflictError(
          'node-run-task-mismatch',
          `node_run ${input.nodeRunId} does not belong to task ${input.taskId}`,
        )
      }
      const identity = (
        await tx
          .select({ nodeId: nodeRuns.nodeId })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, input.nodeRunId))
          .limit(1)
      )[0]
      if (identity?.nodeId !== input.nodeId) {
        throw new ConflictError(
          'node-run-node-mismatch',
          `node_run ${input.nodeRunId} does not belong to node ${input.nodeId}`,
        )
      }
      await createPostgresqlNodeRunLifecycleParticipantInTx(tx).set({
        nodeRunId: input.nodeRunId,
        to: input.status,
        allowedFrom: [input.expectedStatus],
        extra: { finishedAt: input.finishedAt },
        reason: input.cause,
      })
      return await appendPostgresqlTaskNodeStatusesTx(tx, {
        taskId: input.taskId,
        reason: 'human-gate',
        nodeChanges: [
          {
            nodeRunId: input.nodeRunId,
            nodeId: input.nodeId,
            status: input.status,
            cause: input.cause,
          },
        ],
        occurredAt: input.occurredAt,
        identity: input.identity,
      })
    },
  })
}

export class PostgresqlNodeRunLifecyclePersistence implements NodeRunLifecyclePersistence {
  constructor(private readonly db: PostgresqlDatabaseClient) {}

  async mint(input: NodeRunMintInput): Promise<string> {
    const { executionContext } = input
    return await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      await fence(tx, input.taskId, executionContext, Date.now())
      return await createPostgresqlNodeRunMintParticipantInTx(tx).mint(input)
    })
  }

  async transition(
    input: Parameters<NodeRunLifecyclePersistence['transition']>[0],
  ): ReturnType<NodeRunLifecyclePersistence['transition']> {
    return await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      const row = await rowForUpdate(tx, input.nodeRunId)
      await fence(tx, row.taskId, input.executionContext, Date.now())
      const to = nextNodeRunStatus(row.status, input.event)
      assertSourceTerminationAdmission({
        taskId: row.taskId,
        fence: row.sourceTerminationFence,
        to,
      })
      const updated = await tx
        .update(nodeRuns)
        .set({ status: to, ...(input.extra ?? {}) })
        .where(and(eq(nodeRuns.id, input.nodeRunId), eq(nodeRuns.status, row.status)))
        .returning({ id: nodeRuns.id })
      if (updated[0] === undefined) {
        throw new ConflictError(
          'concurrent-node-run-transition',
          `node_run ${input.nodeRunId} status changed concurrently`,
        )
      }
      return { from: row.status, to }
    })
  }

  async set(
    input: Parameters<NodeRunLifecyclePersistence['set']>[0],
  ): ReturnType<NodeRunLifecyclePersistence['set']> {
    return await withPostgresqlSerializableTaskExecution(this.db, async (tx) => {
      const row = await rowForUpdate(tx, input.nodeRunId)
      await fence(tx, row.taskId, input.executionContext, Date.now())
      return await createPostgresqlNodeRunLifecycleParticipantInTx(tx).set(input)
    })
  }

  async loadEnvelopeNonce(nodeRunId: string): Promise<string> {
    const rows = await this.db
      .select({ envelopeNonce: nodeRuns.envelopeNonce })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    return rows[0]?.envelopeNonce ?? ''
  }
}
