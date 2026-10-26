import { resolveTaskExecutionGenerationInTx } from './taskExecutionGeneration'
import { tablesOf } from '@/platform/persistence/sessionTables'
// RFC-359 W4-B1 批 2g —— node run 生命周期（mint / transition / set + 事务内参与者）：一份实现，两个 provider 共用。
// 此前 SQLite 侧薄壳套 `modules/task-execution/infrastructure/taskLifecycle.ts` 的同步内核；现在端口两侧都走统一写事务 + owner 围栏。

import { engineOf } from '@/platform/persistence/databaseTransaction'
import { databaseContentColumnsInTx } from '@/platform/content/infrastructure/contentStore'
import {
  allowedFromStatusesForEvent,
  nextNodeRunStatus,
  type NodeRunStatus,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { createRunSelectionParticipantInTx } from './runSelection/table/selectionWrite'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { ConflictError, NotFoundError } from '@/util/errors'
import type {
  NodeRunLifecycleParticipantInTx,
  NodeRunLifecyclePersistence,
  NodeRunMintInput,
} from '../application/ports/nodeRunLifecyclePersistence'
import { setNodeRunStatusTx } from './nodeRunLifecycleTransition'
import { createNodeRunMintParticipantInTx } from './nodeRunMintParticipant'
import { compareAndWriteNodeRunInTx, nodeRunTableWrite } from './nodeRunWriteProtocol'
import {
  fenceTaskWrite,
  type TaskExecutionTransaction,
  withTaskExecutionAggregateWrite,
  withTaskExecutionWrite,
} from './ownedTaskExecution'
import { appendTaskNodeStatusesCommittedEvent } from './taskLifecycleCommittedEvents'

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
  const { tasks } = tablesOf(tx)
  await engineOf(tx).lockAggregateRoot(tx, tasks, tasks.id, taskId)
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
  const { nodeRuns, tasks } = tablesOf(tx)
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
      const { nodeRuns } = tablesOf(tx)
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
        extra: {
          identity: {
            finishedAt: input.finishedAt,
          },
        },
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
  constructor(private readonly db: PersistenceDb) {}

  async mint(input: NodeRunMintInput): Promise<string> {
    const { executionContext, outputs, ...request } = input
    return await withTaskExecutionAggregateWrite(this.db, async (tx) => {
      await fence(tx, input.taskId, executionContext, Date.now())
      const nodeRunId = await createNodeRunMintParticipantInTx(tx).mint(request)
      // 初始输出与行同一事务：见端口注释（io-virtual 行不得在没有输出的状态下被看见）。
      if (outputs !== undefined && outputs.length > 0) {
        const { nodeRunOutputs } = tablesOf(tx)
        for (const output of outputs) {
          await tx.insert(nodeRunOutputs).values({
            nodeRunId,
            portName: output.portName,
            ...(await databaseContentColumnsInTx(
              tx,
              'node-run-output',
              JSON.stringify([nodeRunId, output.portName]),
              new TextEncoder().encode(output.content),
              input.taskId,
            )),
            kind: output.kind ?? null,
            archiveJson: output.archiveJson ?? null,
            active: output.active ?? true,
          })
        }
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
      if (input.executionGeneration)
        await resolveTaskExecutionGenerationInTx(tx, row.taskId, input.executionGeneration)
      const to = nextNodeRunStatus(row.status, input.event)
      assertSourceTerminationAdmission({
        taskId: row.taskId,
        fence: row.sourceTerminationFence,
        to,
      })
      const { nodeRuns } = tablesOf(tx)
      await compareAndWriteNodeRunInTx(
        tx,
        input.nodeRunId,
        eq(nodeRuns.status, row.status),
        { ...input.extra?.identity, status: to },
        nodeRunTableWrite(input.extra ?? {}),
      )
      if (input.selection !== undefined)
        await createRunSelectionParticipantInTx().apply(tx, [input.selection])
      return { from: row.status, to }
    })
  }

  async set(
    input: Parameters<NodeRunLifecyclePersistence['set']>[0],
  ): ReturnType<NodeRunLifecyclePersistence['set']> {
    return await withTaskExecutionWrite(this.db, async (tx) => {
      const row = await rowForUpdate(tx, input.nodeRunId)
      await fence(tx, row.taskId, input.executionContext, Date.now())
      if (input.executionGeneration)
        await resolveTaskExecutionGenerationInTx(tx, row.taskId, input.executionGeneration)
      return await createNodeRunLifecycleParticipantInTx(tx).set(input)
    })
  }

  async loadEnvelopeNonce(nodeRunId: string): Promise<string> {
    const { nodeRuns } = tablesOf(this.db)
    const rows = await this.db
      .select({ envelopeNonce: nodeRuns.envelopeNonce })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
    const nonce = rows[0]?.envelopeNonce
    if (!nonce)
      throw new ConflictError(
        'node-run-envelope-unavailable',
        `node_run ${nodeRunId} has no executable envelope`,
      )
    return nonce
  }
}
