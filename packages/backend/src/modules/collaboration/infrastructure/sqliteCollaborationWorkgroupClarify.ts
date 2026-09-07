import type { WorkgroupAssignmentStatus } from '@agent-workflow/shared'
import {
  parseBatchShardKey,
  parseMsgShardKey,
  resolveClarifyBudget,
  wgClarifyAskerKey,
  workgroupHasHumanMember,
} from '@agent-workflow/shared'
import { and, eq, inArray } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { clarifyRounds, nodeRuns, tasks, workgroupAssignments } from '@/db/schema'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { setNodeRunStatusTx } from '@/modules/task-execution/infrastructure/nodeRunLifecycleTransition'
import { TASK_CHANNEL, taskBroadcaster } from '@/ws/broadcaster'
import type {
  CollaborationAutonomousDismissalInput,
  CollaborationAutonomousDismissalResult,
  CollaborationClarifySuppressionInput,
} from '../application/ports/collaborationRuntimeMechanics'
import { createClarifyDirectiveStore } from './clarifyDirectiveStore'

const WG_LEADER_NODE_ID = '__wg_leader__'

function canRequeueAssignment(
  from: WorkgroupAssignmentStatus,
  to: WorkgroupAssignmentStatus,
): boolean {
  return from === 'awaiting_human' && (to === 'open' || to === 'dispatched')
}

async function countClarifyAsks(
  db: ProviderNeutralDatabase,
  taskId: string,
  askerKey: string,
): Promise<number> {
  const rows = await db
    .select({ nodeId: clarifyRounds.askingNodeId, shardKey: clarifyRounds.askingShardKey })
    .from(clarifyRounds)
    .where(and(eq(clarifyRounds.kind, 'self'), eq(clarifyRounds.taskId, taskId)))
  return rows.filter(
    (row) => wgClarifyAskerKey(row.nodeId, row.shardKey, WG_LEADER_NODE_ID) === askerKey,
  ).length
}

/** 实时反问许可（预算 / 已问次数 / stop 指令）：一份实现，两个 provider 共用。 */
export async function isTaskClarifySuppressed(
  db: ProviderNeutralDatabase,
  input: CollaborationClarifySuppressionInput,
): Promise<boolean> {
  const row = (
    await db
      .select({ config: tasks.workgroupConfigJson })
      .from(tasks)
      .where(eq(tasks.id, input.taskId))
      .limit(1)
  )[0]
  if (row?.config === null || row?.config === undefined) return false
  try {
    const parsed = JSON.parse(row.config) as { members?: unknown; clarifyBudget?: number }
    if (!Array.isArray(parsed.members)) return false
    const members = parsed.members.filter(
      (member): member is { memberType: 'agent' | 'human' } =>
        typeof member === 'object' && member !== null && 'memberType' in member,
    )
    if (!workgroupHasHumanMember(members)) return true
    if (input.nodeId === undefined) return false
    const budget = resolveClarifyBudget({ clarifyBudget: parsed.clarifyBudget })
    if (budget <= 0) return true
    const askerKey = wgClarifyAskerKey(input.nodeId, input.shardKey ?? null, WG_LEADER_NODE_ID)
    const directive = await createClarifyDirectiveStore(db).get({
      taskId: input.taskId,
      nodeId: input.nodeId,
      shardKey: askerKey,
    })
    if (directive?.directive === 'stop') return true
    return (await countClarifyAsks(db, input.taskId, askerKey)) >= budget
  } catch {
    return false
  }
}

/**
 * Atomically closes every open self-clarify park and requeues its workgroup
 * assignment. Broadcasts are emitted only after the transaction lands.
 */
export async function dismissOpenClarifyParksForAutonomous(
  db: ProviderNeutralDatabase,
  input: CollaborationAutonomousDismissalInput,
): Promise<CollaborationAutonomousDismissalResult> {
  const resolvedMode =
    input.mode ??
    (await (async () => {
      const row = (
        await db
          .select({ config: tasks.workgroupConfigJson })
          .from(tasks)
          .where(eq(tasks.id, input.taskId))
          .limit(1)
      )[0]
      if (row?.config === null || row?.config === undefined) return 'leader_worker'
      try {
        const parsed = JSON.parse(row.config) as { mode?: unknown }
        return typeof parsed.mode === 'string' ? parsed.mode : 'leader_worker'
      } catch {
        return 'leader_worker'
      }
    })())

  const result = await databaseSessionFor(db).transaction(async (tx) => {
    let dismissedSessionCount = 0
    const dismissedSessions: Array<{ nodeRunId: string; nodeId: string }> = []
    const requeuedAssignments: Array<{ id: string; to: WorkgroupAssignmentStatus }> = []
    const open = await tx
      .select({
        id: clarifyRounds.id,
        nodeRunId: clarifyRounds.intermediaryNodeRunId,
        nodeId: clarifyRounds.intermediaryNodeId,
        shardKey: clarifyRounds.askingShardKey,
      })
      .from(clarifyRounds)
      .where(
        and(
          eq(clarifyRounds.kind, 'self'),
          eq(clarifyRounds.taskId, input.taskId),
          eq(clarifyRounds.status, 'awaiting_human'),
        ),
      )

    for (const round of open) {
      dismissedSessionCount += 1
      const parked = (
        await tx
          .select({ status: nodeRuns.status })
          .from(nodeRuns)
          .where(eq(nodeRuns.id, round.nodeRunId))
          .limit(1)
      )[0]
      if (parked?.status === 'awaiting_human') {
        await setNodeRunStatusTx({
          tx,
          nodeRunId: round.nodeRunId,
          to: 'canceled',
          allowedFrom: ['awaiting_human'],
          extra: {
            finishedAt: Date.now(),
            errorMessage: 'wg-clarify-disabled',
          },
          reason: 'wg-clarify-disabled',
        })
        dismissedSessions.push({ nodeRunId: round.nodeRunId, nodeId: round.nodeId })
      }
      await tx
        .update(clarifyRounds)
        .set({ status: 'canceled' })
        .where(and(eq(clarifyRounds.id, round.id), eq(clarifyRounds.status, 'awaiting_human')))

      const shard = round.shardKey
      if (shard === null || parseMsgShardKey(shard) !== null) continue
      const batch = parseBatchShardKey(shard)
      const assignmentIds = batch === null ? [shard] : batch.assignmentIds
      const to: WorkgroupAssignmentStatus = resolvedMode === 'free_collab' ? 'open' : 'dispatched'
      if (!canRequeueAssignment('awaiting_human', to)) {
        throw new Error(`illegal workgroup assignment transition awaiting_human -> ${to}`)
      }
      const requeued = await tx
        .update(workgroupAssignments)
        .set({
          status: to,
          nodeRunId: null,
          ...(resolvedMode === 'free_collab' ? { assigneeMemberId: null } : {}),
          updatedAt: Date.now(),
        })
        .where(
          and(
            inArray(workgroupAssignments.id, assignmentIds),
            eq(workgroupAssignments.taskId, input.taskId),
            eq(workgroupAssignments.status, 'awaiting_human'),
          ),
        )
        .returning({ id: workgroupAssignments.id })
      for (const assignment of requeued) requeuedAssignments.push({ id: assignment.id, to })
    }

    return {
      dismissedSessions: dismissedSessionCount,
      canceledParkRuns: dismissedSessions,
      requeuedAssignments,
    }
  })

  for (const run of result.canceledParkRuns) {
    taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId), {
      id: -1,
      type: 'node.status',
      nodeRunId: run.nodeRunId,
      nodeId: run.nodeId,
      status: 'canceled',
    })
  }
  for (const assignment of result.requeuedAssignments) {
    taskBroadcaster.broadcast(TASK_CHANNEL(input.taskId), {
      id: -1,
      type: 'wg.assignment.updated',
      assignmentId: assignment.id,
      status: assignment.to,
    })
  }
  return result
}
