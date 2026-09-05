// RFC-359 W4-B1 批 2g —— node run 生命周期（mint / transition / set + 事务内参与者）：一份实现，两个 provider 共用。
// 此前 SQLite 侧薄壳套 `platform/persistence/sqlite/taskLifecycle.ts` 的同步内核；现在端口两侧都走统一写事务 + owner 围栏。

import {
  allowedFromStatusesForEvent,
  nextNodeRunStatus,
  type NodeRunStatus,
} from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'

import { nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import type { ProviderNeutralDatabase } from '@/db/query'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  NodeRunLifecyclePersistence,
  NodeRunMintInput,
} from '../application/ports/nodeRunLifecyclePersistence'
import type { NodeRunLifecycleParticipantInTx } from '../public/commands'
import {
  fenceTaskWrite,
  type TaskExecutionTransaction,
  withTaskExecutionWrite,
} from './ownedTaskExecution'
import { appendTaskNodeStatusesCommittedEvent } from './taskLifecycleCommittedEvents'
import { createNodeRunMintParticipantInTx } from './nodeRunMintParticipant'
import { setNodeRunStatusTx } from './nodeRunLifecycleTransition'

const SOURCE_TERMINATION_BLOCKED_NODE_STATUSES = new Set(
  allowedFromStatusesForEvent({ kind: 'mark-canceled' }),
)

async function fence(
  tx: TaskExecutionTransaction,
  taskId: string,
  explicitContext: NodeRunMintInput['executionContext'],
  now: number,
): Promise<void> {
  // 围栏规则两引擎同一（ownedTaskExecution）：显式上下文 > 环境上下文 > 无主围栏。
  await fenceTaskWrite(tx, { taskId, context: explicitContext, now })
}

async function rowForUpdate(
  tx: TaskExecutionTransaction,
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
 * database transaction.  The caller owns transaction admission; this
 * participant owns status legality, source-terminal fencing and the CAS.
 */
export function createNodeRunLifecycleParticipantInTx(
  tx: TaskExecutionTransaction,
): NodeRunLifecycleParticipantInTx {
  return Object.freeze({
    async set(input: Parameters<NodeRunLifecycleParticipantInTx['set']>[0]) {
      // RFC-359 W1-T2c：事务内 CAS 与 SQLite 同一份实现（nodeRunLifecycleTransition.ts）。
      return await setNodeRunStatusTx({ tx, ...input })
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
      await createNodeRunLifecycleParticipantInTx(tx).set({
        nodeRunId: input.nodeRunId,
        to: input.status,
        allowedFrom: [input.expectedStatus],
        extra: { finishedAt: input.finishedAt },
        reason: input.cause,
      })
      return await appendTaskNodeStatusesCommittedEvent(tx, {
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

export class DrizzleNodeRunLifecyclePersistence implements NodeRunLifecyclePersistence {
  constructor(private readonly db: ProviderNeutralDatabase) {}

  async mint(input: NodeRunMintInput): Promise<string> {
    const { executionContext, outputs, ...request } = input
    return await withTaskExecutionWrite(this.db, async (tx) => {
      await fence(tx, input.taskId, executionContext, Date.now())
      const nodeRunId = await createNodeRunMintParticipantInTx(tx).mint(request)
      // 初始输出与行同一事务：见端口注释（io-virtual 行不得在没有输出的状态下被看见）。
      if (outputs !== undefined && outputs.length > 0) {
        await tx
          .insert(nodeRunOutputs)
          .values(
            outputs.map((output) => ({
              nodeRunId,
              portName: output.portName,
              content: output.content,
              kind: output.kind ?? null,
              archiveJson: output.archiveJson ?? null,
              active: output.active ?? true,
            })),
          )
          .run()
      }
      return nodeRunId
    })
  }

  async transition(
    input: Parameters<NodeRunLifecyclePersistence['transition']>[0],
  ): ReturnType<NodeRunLifecyclePersistence['transition']> {
    return await withTaskExecutionWrite(this.db, async (tx) => {
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
    return await withTaskExecutionWrite(this.db, async (tx) => {
      const row = await rowForUpdate(tx, input.nodeRunId)
      await fence(tx, row.taskId, input.executionContext, Date.now())
      return await createNodeRunLifecycleParticipantInTx(tx).set(input)
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
